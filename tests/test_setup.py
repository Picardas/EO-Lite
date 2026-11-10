"""Setting EO-Lite up, and what it tells its dashboard."""

from __future__ import annotations

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.config_entries import SOURCE_USER
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType
from homeassistant.exceptions import Unauthorized

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, DOMAIN
from custom_components.eo_lite.engine import EoLite

from .conftest import ALLOW, ONLY_TIMERS, Charger, set_up, ws


async def test_setup_finds_the_charger(hass: HomeAssistant, charger: Charger) -> None:
    # Another switch that only looks a bit like a charger's.
    hass.states.async_set("switch.garage_charging", "off")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    # The charger's offered, already chosen; the dashboard's on by default.
    options = result["data_schema"].schema[CONF_CHARGER].config["options"]
    assert [option["value"] for option in options] == ["openeo_charger"]
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CHARGER: "openeo_charger", CONF_DASHBOARD: True}
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "EO-Lite"
    assert result["data"] == {CONF_CHARGER: "openeo_charger"}
    assert result["options"] == {CONF_DASHBOARD: True}
    # Its two toggles are there.
    assert hass.states.get(ALLOW) is not None
    assert hass.states.get(ONLY_TIMERS) is not None


async def test_setup_without_a_charger(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_charger"


async def test_only_set_up_once(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


async def test_script_is_on_every_page_while_set_up(hass: HomeAssistant, charger: Charger, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    assert [url.split("?")[0] for url in urls] == ["/eo_lite/eo-lite-loader.js"]
    # Versioned by its content, so browsers pick up a new one.
    assert "?v=" in next(iter(urls))
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert not hass.data[DATA_EXTRA_MODULE_URL].urls


async def test_dashboard_is_told_the_entities(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    result = ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]
    assert result["charger"] == "openeo_charger"
    assert result["add_dashboard"] is True
    entities = result["entities"]
    # Its own toggles, and the charger's entities.
    assert entities["allow_charging"] == ALLOW
    assert entities["only_during_timers"] == ONLY_TIMERS
    assert entities["state"] == "sensor.openeo_charger_charger_state"
    assert entities["power"] == "sensor.openeo_charger_power_delivered"
    assert entities["add_timer"] == "button.openeo_charger_add_charge_schedule"


async def test_dashboard_commands_while_not_set_up(hass: HomeAssistant, charger: Charger, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    assert await hass.config_entries.async_unload(entry.entry_id)
    connection = ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"})
    assert connection.send_error.call_args.args[1] == "not_loaded"


async def test_dashboard_is_added_once(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    def claim(**msg: object) -> bool:
        connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": "eo_lite/claim_dashboard", "release": False, **msg})
        return connection.send_result.call_args.args[1]["claimed"]

    # The first admin's browser to ask adds it; the next doesn't.
    assert claim() is True
    assert claim() is False
    assert ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]["add_dashboard"] is False
    # Adding it failed: the claim's given back, and the next to ask tries again.
    assert claim(release=True, error="no such command") is False
    assert claim() is True


async def test_dashboard_is_not_added_when_turned_off(hass: HomeAssistant, charger: Charger) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: "openeo_charger"}, options={CONF_DASHBOARD: False})
    await set_up(hass, entry)
    result = ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]
    assert result["add_dashboard"] is False
    connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": "eo_lite/claim_dashboard", "release": False})
    assert connection.send_result.call_args.args[1]["claimed"] is False


async def test_only_admins_add_the_dashboard(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    with pytest.raises(Unauthorized):
        ws(hass, dashboard.websocket_claim_dashboard, {"type": "eo_lite/claim_dashboard", "release": False}, admin=False)
    assert eo_lite.dashboard_added is False
