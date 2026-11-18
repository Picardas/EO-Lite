"""Finding the charger's timers and entities by openeo's own ids, whatever
Home Assistant names them, and telling the dashboard as they change."""

from __future__ import annotations

from unittest.mock import Mock

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import HomeAssistant
from homeassistant.helpers import entity_registry as er

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, DOMAIN

from .conftest import set_up, ws

DEVICE = "openeo_charger_1"


def mqtt(hass: HomeAssistant, domain: str, unique: str, entity_id: str, state: str = "unknown") -> str:
    """One of openeo's entities, as MQTT discovery registers it: openeo's id,
    and the entity id Home Assistant gave it."""
    registry = er.async_get(hass)
    entry = registry.async_get_or_create(domain, "mqtt", f"{DEVICE}_{unique}", suggested_object_id=entity_id.split(".")[1])
    assert entry.entity_id == entity_id
    hass.states.async_set(entity_id, state)
    return entity_id


def add_timer(hass: HomeAssistant, n: int, prefix: str = "openeo_charger") -> None:
    """Timer n's entities, named as Home Assistant names them now that the
    charger's in an area (or plainly, for the first)."""
    mqtt(hass, "number", f"schedule_{n}_amps", f"number.{prefix}_charge_schedule_{n}_current", "16")
    mqtt(hass, "time", f"schedule_{n}_start", f"time.{prefix}_charge_schedule_{n}_start", "22:00:00")
    mqtt(hass, "time", f"schedule_{n}_end", f"time.{prefix}_charge_schedule_{n}_end", "06:00:00")
    mqtt(hass, "button", f"schedule_{n}_delete", f"button.{prefix}_delete_charge_schedule_{n}")


def delete_timer(hass: HomeAssistant, n: int, prefix: str) -> None:
    """openeo takes the highest timer's entities away when one's deleted."""
    registry = er.async_get(hass)
    for entity_id in (
        f"number.{prefix}_charge_schedule_{n}_current",
        f"time.{prefix}_charge_schedule_{n}_start",
        f"time.{prefix}_charge_schedule_{n}_end",
        f"button.{prefix}_delete_charge_schedule_{n}",
    ):
        registry.async_remove(entity_id)
        hass.states.async_remove(entity_id)


@pytest.fixture
async def openeo(hass: HomeAssistant) -> None:
    """A charger as openeo puts it in Home Assistant: its first entities named
    plainly, then the charger put in the Front garden area."""
    mqtt(hass, "switch", "charging", "switch.openeo_charger_charging", "off")
    mqtt(hass, "switch", "timers_switch", "switch.openeo_charger_timers", "off")
    mqtt(hass, "sensor", "charger_state", "sensor.openeo_charger_charger_state", "idle")
    mqtt(hass, "sensor", "current_vehicle", "sensor.openeo_charger_vehicle_current", "0")
    mqtt(hass, "button", "schedule_add", "button.openeo_charger_add_charge_schedule")
    # openeo's solar timers aren't charge timers.
    mqtt(hass, "number", "solar_schedule_1_amps", "number.openeo_charger_solar_schedule_1_reservation", "0")
    add_timer(hass, 1)


@pytest.fixture
def entry() -> MockConfigEntry:
    return MockConfigEntry(domain=DOMAIN, data={CONF_CHARGER: "openeo_charger"}, options={CONF_DASHBOARD: False})


def config(hass: HomeAssistant) -> dict:
    return ws(hass, dashboard.websocket_config, {"type": "eo_lite/config"}).send_result.call_args.args[1]


def subscribe(hass: HomeAssistant) -> Mock:
    connection = ws(hass, dashboard.websocket_subscribe, {"type": "eo_lite/subscribe"})
    connection.send_result.assert_called_once()
    return connection


def last(connection: Mock) -> dict:
    return connection.send_message.call_args.args[0]["event"]


async def test_timers_named_after_the_area_are_found(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    # Timers 2 and 10 were added after the charger was put in the Front garden.
    add_timer(hass, 2, "front_garden_openeo_charger")
    add_timer(hass, 10, "front_garden_openeo_charger")
    await set_up(hass, entry)
    timers = last(subscribe(hass))["timers"]
    # In order, timer 1 by its plain name and the rest by theirs.
    assert [t["n"] for t in timers] == [1, 2, 10]
    assert timers[1] == {
        "n": 2,
        "current": "number.front_garden_openeo_charger_charge_schedule_2_current",
        "start": "time.front_garden_openeo_charger_charge_schedule_2_start",
        "end": "time.front_garden_openeo_charger_charge_schedule_2_end",
        "remove": "button.front_garden_openeo_charger_delete_charge_schedule_2",
    }
    assert timers[0]["current"] == "number.openeo_charger_charge_schedule_1_current"


async def test_a_new_timer_reaches_the_dashboard(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    connection = subscribe(hass)
    assert [t["n"] for t in last(connection)["timers"]] == [1]
    # New timer pressed: openeo adds timer 2, and Home Assistant names it after the area.
    add_timer(hass, 2, "front_garden_openeo_charger")
    await hass.async_block_till_done()
    assert [t["n"] for t in last(connection)["timers"]] == [1, 2]
    # Deleted again: openeo takes timer 2's entities away.
    delete_timer(hass, 2, "front_garden_openeo_charger")
    await hass.async_block_till_done()
    assert [t["n"] for t in last(connection)["timers"]] == [1]
    # The dashboard's told only when something changed.
    sent = connection.send_message.call_count
    er.async_get(hass).async_get_or_create("light", "hue", "kitchen")
    await hass.async_block_till_done()
    assert connection.send_message.call_count == sent


async def test_the_charger_s_entities_are_found_whatever_they_re_called(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    # The charger's state sensor was renamed.
    er.async_get(hass).async_update_entity("sensor.openeo_charger_charger_state", new_entity_id="sensor.front_garden_charger_state")
    await set_up(hass, entry)
    entities = config(hass)["entities"]
    assert entities["state"] == "sensor.front_garden_charger_state"
    assert entities["add_timer"] == "button.openeo_charger_add_charge_schedule"
    assert entities["vehicle_current"] == "sensor.openeo_charger_vehicle_current"
    # Ones openeo hasn't made keep their usual names.
    assert entities["session_cost"] == "sensor.openeo_charger_session_cost"


async def test_another_charger_s_timers_are_left_out(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    er.async_get(hass).async_get_or_create("number", "mqtt", "garage_charger_schedule_2_amps", suggested_object_id="garage_schedule_2")
    await set_up(hass, entry)
    assert [t["n"] for t in last(subscribe(hass))["timers"]] == [1]


async def test_the_dashboard_is_told_the_timer_openeo_adds(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    assert last(subscribe(hass))["default_timer"] == {"start": "22:00", "end": "06:00", "amps": 16}


async def test_a_charger_not_in_the_registry_is_found_by_name(hass: HomeAssistant, charger, entry: MockConfigEntry) -> None:
    # The stand-in charger's switches have no unique ids.
    await set_up(hass, entry)
    message = last(subscribe(hass))
    assert message["timers"] is None
    assert message["entities"]["charging_switch"] == "switch.openeo_charger_charging"


async def test_dashboards_open_through_a_reload_are_told_again(hass: HomeAssistant, openeo: None, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    connection = subscribe(hass)
    sent = connection.send_message.call_count
    assert await hass.config_entries.async_reload(entry.entry_id)
    await hass.async_block_till_done()
    assert connection.send_message.call_count > sent
