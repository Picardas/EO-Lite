"""Finding the charger's entities.

openeo gives every entity a fixed id of its own (its unique id: the
charger's device id, like openeo_charger_1, then what the entity is), but
Home Assistant names the entities as it likes: ones made after the charger
was put in an area start with the area's name
(number.front_garden_openeo_charger_charge_schedule_2_current). So the
charger's entities are found in the entity registry by openeo's ids, from
its charging switch's. A charger that isn't in the registry (no unique ids)
is found by the names its integration gives, as at first.
"""

from __future__ import annotations

import re
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import charger_entities

# Each entity EO-Lite uses: its domain and openeo's name for it (its unique
# id after the device id).
OPENEO_IDS = {
    "charging_switch": ("switch", "charging"),
    "timers_switch": ("switch", "timers_switch"),
    "state": ("sensor", "charger_state"),
    "power": ("sensor", "power_delivered"),
    "vehicle_current": ("sensor", "current_vehicle"),
    "charging_active": ("binary_sensor", "charging_active"),
    "vehicle_connected": ("binary_sensor", "vehicle_connected"),
    "session_kwh": ("sensor", "session_kwh"),
    "session_cost": ("sensor", "session_cost"),
    "add_timer": ("button", "schedule_add"),
}

# A timer's entities: openeo's name for each, and what the dashboard calls it.
TIMER_PARTS = {"amps": "current", "start": "start", "end": "end", "delete": "remove"}
TIMER_ID = re.compile(r"^(?P<device>.+)_schedule_(?P<n>[0-9]+)_(?P<part>amps|start|end|delete)$")
TIMER_NAME = re.compile(r"^number\.(?P<charger>.+)_charge_schedule_(?P<n>[0-9]+)_current$")

# The timer openeo adds, and leaves when the last one's deleted.
DEFAULT_TIMER = {"start": "22:00", "end": "06:00", "amps": 16}

type Timer = dict[str, Any]


@callback
def device_id(hass: HomeAssistant, charger: str) -> str | None:
    """openeo's id for the charger (openeo_charger_1), from its charging
    switch's unique id, or None when the charger isn't in the registry."""
    entry = er.async_get(hass).async_get(charger_entities(charger)["charging_switch"])
    if entry is None or entry.platform != "mqtt" or not entry.unique_id.endswith("_charging"):
        return None
    return entry.unique_id.removesuffix("_charging")


@callback
def find(hass: HomeAssistant, charger: str) -> tuple[dict[str, str], list[Timer] | None]:
    """The charger's entities EO-Lite uses, by what they're for, and its
    timers in order ({n, current, start, end, remove}: entity ids). The
    timers are None for a charger that isn't in the registry: the dashboard
    then finds them by name."""
    entities = charger_entities(charger)
    device = device_id(hass, charger)
    if device is None:
        return entities, None
    registry = er.async_get(hass)
    mqtt = {(entry.domain, entry.unique_id): entry.entity_id for entry in registry.entities.values() if entry.platform == "mqtt"}
    for key, (domain, name) in OPENEO_IDS.items():
        if entity_id := mqtt.get((domain, f"{device}_{name}")):
            entities[key] = entity_id
    timers: dict[int, Timer] = {}
    for (_, unique_id), entity_id in mqtt.items():
        match = TIMER_ID.match(unique_id)
        # Not the solar timers (solar_schedule_), or another charger's.
        if match and match["device"] == device:
            timers.setdefault(int(match["n"]), {})[TIMER_PARTS[match["part"]]] = entity_id
    return entities, [{"n": n, **parts} for n, parts in sorted(timers.items()) if "current" in parts]
