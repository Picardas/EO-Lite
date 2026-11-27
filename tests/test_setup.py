"""Setting EO-Lite up, stored state, and what it tells its dashboard."""

from typing import Any

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.config_entries import SOURCE_USER, ConfigEntryState
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import (
    CONF_CHARGER,
    CONF_DASHBOARD,
    CONF_DEVICE,
    DOMAIN,
    OUREO_ENTITIES,
    STORAGE_KEY,
)
from custom_components.eo_lite.engine import EoLite

from .conftest import CHARGER, Oureo, add_simple_charger, set_up, ws


async def test_setup_finds_esphome_charger(hass: HomeAssistant, oureo: Oureo) -> None:
    # An unrelated select entity that shouldn't be offered as a charger.
    hass.states.async_set("select.house_mode", "Home", {"options": ["Home", "Away"]})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    options = result["data_schema"].schema[CONF_CHARGER].config["options"]
    assert options == [{"value": CHARGER, "label": "EO Mini Pro 2"}]
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CHARGER: CHARGER, CONF_DASHBOARD: True}
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["title"] == "EO-Lite"
    assert result["data"] == {CONF_CHARGER: CHARGER, CONF_DEVICE: oureo.device_id}
    assert result["options"] == {CONF_DASHBOARD: True}
    assert result["result"].minor_version == 2


async def test_setup_finds_plain_charger(hass: HomeAssistant) -> None:
    add_simple_charger(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.FORM
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CHARGER: CHARGER, CONF_DASHBOARD: False}
    )
    await hass.async_block_till_done()
    assert result["type"] is FlowResultType.CREATE_ENTRY
    assert result["data"] == {CONF_CHARGER: CHARGER}


async def test_setup_without_a_charger(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_charger"


async def test_only_set_up_once(hass: HomeAssistant, eo_lite: EoLite) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


@pytest.mark.parametrize("asked", ["../x", "house_mode", "eo_mini_pro_2\n", "x" * 10000])
async def test_setup_takes_only_a_charger_it_offered(hass: HomeAssistant, oureo: Oureo, asked: str) -> None:
    hass.states.async_set("select.house_mode", "Home", {"options": ["Home", "Away"]})
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    with pytest.raises(InvalidData):
        await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_CHARGER: asked, CONF_DASHBOARD: True})
    assert not hass.config_entries.async_entries(DOMAIN)


async def test_script_is_on_every_page_while_set_up(hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    urls = hass.data[DATA_EXTRA_MODULE_URL].urls
    assert [url.split("?")[0] for url in urls] == ["/eo_lite/eo-lite-loader.js"]
    assert "?v=" in next(iter(urls))
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert not hass.data[DATA_EXTRA_MODULE_URL].urls


async def test_dashboard_is_told_the_entities(hass: HomeAssistant, eo_lite: EoLite) -> None:
    result = ws(hass, dashboard.websocket_config, {"type": f"{DOMAIN}/config"}).send_result.call_args.args[1]
    assert result["charger"] == CHARGER
    assert result["add_dashboard"] is True
    assert set(result["entities"]) == set(OUREO_ENTITIES)
    assert result["entities"]["charge_mode"] == f"select.{CHARGER}_charge_mode"
    assert result["entities"]["energy_total"] == f"sensor.{CHARGER}_energy_total"
    assert result["entities"]["reset_bridge"] == f"button.{CHARGER}_reset_bridge"


async def test_dashboard_commands_while_not_set_up(hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    assert await hass.config_entries.async_unload(entry.entry_id)
    connection = ws(hass, dashboard.websocket_config, {"type": f"{DOMAIN}/config"})
    assert connection.send_error.call_args.args[1] == "not_loaded"


async def test_a_dashboard_open_before_eo_lite_is_set_up_hears_once_it_is(
    hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry
) -> None:
    first = ws(hass, dashboard.websocket_subscribe, {"type": f"{DOMAIN}/subscribe"})
    second = ws(hass, dashboard.websocket_subscribe, {"type": f"{DOMAIN}/subscribe"})
    for connection in (first, second):
        connection.send_result.assert_called_once()
        connection.send_error.assert_not_called()
        connection.send_message.assert_not_called()
    second.subscriptions[1]()
    await set_up(hass, entry)
    assert first.send_message.call_args.args[0]["event"]["entities"]["charge_mode"] == f"select.{CHARGER}_charge_mode"
    second.send_message.assert_not_called()


async def test_dashboard_is_added_once(hass: HomeAssistant, eo_lite: EoLite) -> None:
    def claim(**msg: object) -> bool:
        connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": f"{DOMAIN}/claim_dashboard", **msg})
        return connection.send_result.call_args.args[1]["claimed"]

    assert claim() is True
    assert claim() is False
    assert (
        ws(hass, dashboard.websocket_config, {"type": f"{DOMAIN}/config"}).send_result.call_args.args[1]["add_dashboard"]
        is False
    )
    assert claim(release=True, error="no such command") is False
    assert claim() is True


async def test_dashboard_is_not_added_when_turned_off(hass: HomeAssistant, oureo: Oureo) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: CHARGER}, options={CONF_DASHBOARD: False}, minor_version=2)
    await set_up(hass, entry)
    result = ws(hass, dashboard.websocket_config, {"type": f"{DOMAIN}/config"}).send_result.call_args.args[1]
    assert result["add_dashboard"] is False
    connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": f"{DOMAIN}/claim_dashboard"})
    assert connection.send_result.call_args.args[1]["claimed"] is False


@pytest.mark.parametrize(
    "data",
    [None, [], "yes", {"dashboard_added": "yes"}, {"dashboard_added": 1}],
)
async def test_damaged_saved_data_is_taken_as_not_known(
    hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry, hass_storage: dict[str, Any], data: Any
) -> None:
    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY, "data": data}
    eo_lite = await set_up(hass, entry)
    assert eo_lite.dashboard_added is False


async def test_saved_data_from_a_later_eo_lite_leaves_it_erroring(
    hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    hass_storage[STORAGE_KEY] = {"version": 99, "minor_version": 1, "key": STORAGE_KEY, "data": {"dashboard_added": True}}
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR


async def test_removing_eo_lite_forgets_stored_data(
    hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    await set_up(hass, entry)
    ws(hass, dashboard.websocket_claim_dashboard, {"type": f"{DOMAIN}/claim_dashboard"})
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert STORAGE_KEY not in hass_storage
