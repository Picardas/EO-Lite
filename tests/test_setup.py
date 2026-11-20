"""Setting EO-Lite up, and what it tells its dashboard."""

from datetime import timedelta
import logging
from typing import Any
from unittest.mock import patch

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, async_fire_time_changed

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL
from homeassistant.config_entries import SOURCE_USER, ConfigEntryState
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import CoreState, HomeAssistant
from homeassistant.data_entry_flow import FlowResultType, InvalidData
from homeassistant.util import dt as dt_util

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, CONF_DEVICE, DOMAIN, STORAGE_KEY
from custom_components.eo_lite.engine import EoLite

from .conftest import ALLOW, CHARGING, ONLY_TIMERS, TIMERS, Charger, Openeo, add_charger, add_openeo, set_up, ws


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
    assert result["result"].minor_version == 2
    # Its two toggles are there.
    assert hass.states.get(ALLOW) is not None
    assert hass.states.get(ONLY_TIMERS) is not None


async def test_setup_remembers_openeo_s_id_for_the_charger(hass: HomeAssistant) -> None:
    await add_openeo(hass)
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    result = await hass.config_entries.flow.async_configure(
        result["flow_id"], {CONF_CHARGER: "openeo_charger", CONF_DASHBOARD: False}
    )
    await hass.async_block_till_done()
    # openeo's own id for it, so it's still found once its entities are renamed.
    assert result["data"] == {CONF_CHARGER: "openeo_charger", CONF_DEVICE: Openeo.DEVICE}


async def test_an_entry_from_before_remembers_the_charger(hass: HomeAssistant) -> None:
    await add_openeo(hass)
    # Set up with an earlier EO-Lite, which didn't remember openeo's id for the charger.
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: "openeo_charger"}, options={CONF_DASHBOARD: False})
    assert entry.minor_version == 1
    await set_up(hass, entry)
    # Brought up to date: it does now.
    assert entry.minor_version == 2
    assert entry.data == {CONF_CHARGER: "openeo_charger", CONF_DEVICE: Openeo.DEVICE}


async def test_setup_without_a_charger(hass: HomeAssistant) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "no_charger"


async def test_only_set_up_once(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    assert result["type"] is FlowResultType.ABORT
    assert result["reason"] == "single_instance_allowed"


@pytest.mark.parametrize("asked", ["../x", "garage_door", "openeo_charger\n", "x" * 10000])
async def test_setup_takes_only_a_charger_it_offered(hass: HomeAssistant, charger: Charger, asked: str) -> None:
    """Asked for anything but a charger it offered (another switch, say),
    setup refuses, and nothing's set up."""
    hass.states.async_set("switch.garage_door", "off")
    result = await hass.config_entries.flow.async_init(DOMAIN, context={"source": SOURCE_USER})
    with pytest.raises(InvalidData):
        await hass.config_entries.flow.async_configure(result["flow_id"], {CONF_CHARGER: asked, CONF_DASHBOARD: True})
    assert not hass.config_entries.async_entries(DOMAIN)


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


async def test_a_dashboard_open_before_eo_lite_is_set_up_hears_once_it_is(
    hass: HomeAssistant, charger: Charger, entry: MockConfigEntry
) -> None:
    # Two dashboards open while EO-Lite isn't set up yet: their subscriptions are taken.
    first = ws(hass, dashboard.websocket_subscribe, {"type": "eo_lite/subscribe"})
    second = ws(hass, dashboard.websocket_subscribe, {"type": "eo_lite/subscribe"})
    for connection in (first, second):
        connection.send_result.assert_called_once()
        connection.send_error.assert_not_called()
        connection.send_message.assert_not_called()
    # The second is closed.
    second.subscriptions[1]()
    # EO-Lite's set up: the open one hears, without asking again; the closed one doesn't.
    await set_up(hass, entry)
    assert first.send_message.call_args.args[0]["event"]["entities"]["charging_switch"] == CHARGING
    second.send_message.assert_not_called()


async def test_dashboard_is_added_once(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    def claim(**msg: object) -> bool:
        connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": "eo_lite/claim_dashboard", **msg})
        return connection.send_result.call_args.args[1]["claimed"]

    # The first admin's browser to ask adds it; the next doesn't.
    assert claim() is True
    assert claim() is False
    assert ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]["add_dashboard"] is False
    # Adding it failed: the claim's given back, and the next to ask tries again.
    assert claim(release=True, error="no such command") is False
    assert claim() is True


async def test_dashboard_is_not_added_when_turned_off(hass: HomeAssistant, charger: Charger) -> None:
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: "openeo_charger"}, options={CONF_DASHBOARD: False}, minor_version=2)
    await set_up(hass, entry)
    result = ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]
    assert result["add_dashboard"] is False
    connection = ws(hass, dashboard.websocket_claim_dashboard, {"type": "eo_lite/claim_dashboard"})
    assert connection.send_result.call_args.args[1]["claimed"] is False


# ---- Starting, stopping and removing -------------------------------------------


async def test_a_failed_start_stops_what_it_started(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    """If starting fails part-way, EO-Lite doesn't go on listening."""
    hass.set_state(CoreState.not_running)
    before = hass.bus.async_listeners().get(EVENT_HOMEASSISTANT_STARTED, 0)
    entry.add_to_hass(hass)
    # Starting fails after it's begun waiting for Home Assistant to start.
    with patch("custom_components.eo_lite.engine.async_dispatcher_send", side_effect=RuntimeError("boom")):
        assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    # It isn't waiting any more.
    assert hass.bus.async_listeners().get(EVENT_HOMEASSISTANT_STARTED, 0) == before


async def test_reloading_after_home_assistant_has_started_logs_no_error(
    hass: HomeAssistant, entry: MockConfigEntry, caplog: pytest.LogCaptureFixture
) -> None:
    # EO-Lite is set up as Home Assistant starts, as it is on every restart.
    hass.set_state(CoreState.not_running)
    await add_charger(hass)
    await set_up(hass, entry)
    await hass.async_start()
    await hass.async_block_till_done()
    # Later, it's reloaded.
    caplog.clear()
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR] == []


async def test_a_removed_eo_lite_stays_forgotten(
    hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    """The charger turning up while EO-Lite saves on its way out doesn't
    bring its saved data back once it's removed."""
    # EO-Lite's set up before the charger's there.
    eo_lite = await set_up(hass, entry)
    store = eo_lite._store
    write = store._async_write_data

    async def write_while_the_charger_appears(*args: Any) -> None:
        # The charger appears while the file's being written (Home Assistant
        # writes in another thread, so events go on meanwhile).
        hass.states.async_set(CHARGING, "on")
        hass.states.async_set(TIMERS, "off")
        await write(*args)

    with patch.object(store, "_async_write_data", write_while_the_charger_appears):
        await hass.config_entries.async_remove(entry.entry_id)
    assert DOMAIN not in hass_storage
    # Well after a delayed save would have been written.
    async_fire_time_changed(hass, dt_util.utcnow() + timedelta(seconds=30))
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage


# ---- Stored data -----------------------------------------------------------------


@pytest.mark.parametrize(
    "data",
    [
        None,
        [],
        "allow_charging",
        {"allow_charging": 1, "only_during_timers": 1},
        {"allow_charging": "true", "only_during_timers": "true"},
        {"allow_charging": [True], "only_during_timers": {"on": True}},
        {"allow_charging": None, "only_during_timers": True, "dashboard_added": "yes"},
        {"dashboard_added": 1},
    ],
)
async def test_damaged_saved_data_is_taken_as_not_known(
    hass: HomeAssistant, charger: Charger, entry: MockConfigEntry, hass_storage: dict[str, Any], data: Any
) -> None:
    """Saved data that isn't as EO-Lite saves it: the toggles start as the
    charger is (both off here), and the dashboard's still to be added."""
    hass_storage[STORAGE_KEY] = {"version": 1, "minor_version": 1, "key": STORAGE_KEY, "data": data}
    eo_lite = await set_up(hass, entry)
    assert eo_lite.settings == {"allow_charging": False, "only_during_timers": False}
    assert eo_lite.dashboard_added is False
    assert not charger.charges(in_timer=True)


async def test_saved_data_from_a_later_eo_lite_leaves_the_charger_alone(
    hass: HomeAssistant, charger: Charger, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    """Saved by a later EO-Lite (or tampered with): it isn't set up, and the
    charger's left as it is."""
    data = {"allow_charging": True}
    hass_storage[STORAGE_KEY] = {"version": 99, "minor_version": 1, "key": STORAGE_KEY, "data": data}
    entry.add_to_hass(hass)
    assert not await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert entry.state is ConfigEntryState.SETUP_ERROR
    assert not charger.charges(in_timer=True)
