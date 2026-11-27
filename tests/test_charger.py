"""Finding Oureo's 29 entities in the registry, tracking renames, and
ignoring unrelated registry activity."""

from typing import Any

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from custom_components.eo_lite import charger as charger_lookup, dashboard
from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, DOMAIN, OUREO_ENTITIES

from .conftest import CHARGER, Oureo, add_simple_charger, set_up, ws


def subscribe(hass: HomeAssistant) -> Any:
    connection = ws(hass, dashboard.websocket_subscribe, {"type": f"{DOMAIN}/subscribe"})
    connection.send_result.assert_called_once()
    return connection


def last_event(connection: Any) -> dict[str, Any]:
    return connection.send_message.call_args.args[0]["event"]


async def test_all_29_entities_mapped_accurately(hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry) -> None:
    # Rename entities whose object_ids are substrings of others to verify exact component matching.
    await oureo.rename("current", "sensor.driveway_phase_1_current")
    await oureo.rename("hw_max_current", "sensor.driveway_hw_limit")
    await oureo.rename("watchdog_current", "sensor.driveway_wd_current")
    await oureo.rename("charger_state", "sensor.driveway_charger_state")
    await oureo.rename("eo_firmware_version", "sensor.driveway_fw_version")

    eo_lite = await set_up(hass, entry)
    assert len(eo_lite.charger_entities) == 29
    assert set(eo_lite.charger_entities) == set(OUREO_ENTITIES)
    assert eo_lite.charger_entities["current"] == "sensor.driveway_phase_1_current"
    assert eo_lite.charger_entities["hw_max_current"] == "sensor.driveway_hw_limit"
    assert eo_lite.charger_entities["watchdog_current"] == "sensor.driveway_wd_current"
    assert eo_lite.charger_entities["charger_state"] == "sensor.driveway_charger_state"
    assert eo_lite.charger_entities["eo_firmware_version"] == "sensor.driveway_fw_version"


async def test_renamed_entities_are_tracked_and_pushed(hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    connection = subscribe(hass)
    assert last_event(connection)["entities"]["charge_mode"] == f"select.{CHARGER}_charge_mode"

    await oureo.rename("charge_mode", "select.driveway_charge_mode")
    assert last_event(connection)["entities"]["charge_mode"] == "select.driveway_charge_mode"

    await oureo.rename("timer_1_start", "time.driveway_timer_1_from")
    assert last_event(connection)["entities"]["timer_1_start"] == "time.driveway_timer_1_from"

    await oureo.rename("charger_state", "sensor.driveway_state")
    assert last_event(connection)["entities"]["charger_state"] == "sensor.driveway_state"


async def test_unrelated_registry_events_do_not_search(
    hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry, monkeypatch: pytest.MonkeyPatch
) -> None:
    searches: list[str] = []
    real = charger_lookup.find

    def find(hass: HomeAssistant, charger: str, device: str | None = None) -> dict[str, str]:
        searches.append(charger)
        return real(hass, charger, device)

    monkeypatch.setattr(charger_lookup, "find", find)
    await set_up(hass, entry)
    searches.clear()

    registry = er.async_get(hass)
    for i in range(25):
        registry.async_get_or_create("sensor", "esphome", f"other_device-sensor-temp_{i}", suggested_object_id=f"other_{i}")
    other = registry.async_get_or_create("light", "hue", "kitchen")
    registry.async_update_entity(other.entity_id, new_entity_id="light.kitchen_ceiling")
    registry.async_remove("light.kitchen_ceiling")
    await hass.async_block_till_done()
    assert searches == []


async def test_fallback_by_name_without_registry_entries(hass: HomeAssistant) -> None:
    expected = add_simple_charger(hass)
    entry = MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: CHARGER}, options={CONF_DASHBOARD: False}, minor_version=2)
    eo_lite = await set_up(hass, entry)
    assert eo_lite.charger_entities == expected
