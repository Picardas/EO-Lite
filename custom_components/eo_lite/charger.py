"""Finding the Oureo charger's entities in Home Assistant's entity registry."""

import re
from typing import Any

from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import entity_registry as er

from .const import OUREO_ENTITIES, charger_entities

# Home Assistant device id for the ESPHome charger, checked when read.
DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{1,64}")


def valid_device(value: Any) -> str | None:
    """The remembered device id, if it looks like one."""
    return value if isinstance(value, str) and DEVICE_ID.fullmatch(value) else None


@callback
def device_id(hass: HomeAssistant, charger: str) -> str | None:
    """Home Assistant's device id for the ESPHome charger, from its
    charge_mode select entity, or None when it isn't registered by ESPHome."""
    entry = er.async_get(hass).async_get(charger_entities(charger)["charge_mode"])
    if entry is None or entry.platform != "esphome":
        return None
    return valid_device(entry.device_id)


def _matches(entry: er.RegistryEntry, domain: str, component: str, object_id: str) -> bool:
    """Whether an ESPHome registry entry belongs to `object_id`."""
    if entry.platform != "esphome" or entry.domain != domain:
        return False
    return entry.unique_id.endswith(f"-{component}-{object_id}") or (
        component == "text_sensor" and entry.unique_id.endswith(f"-sensor-{object_id}")
    )


@callback
def find(hass: HomeAssistant, charger: str, device: str | None = None) -> dict[str, str]:
    """The charger's 29 entities, resolved from the ESPHome device in the
    entity registry when `device` is known, falling back to their default names."""
    entities = charger_entities(charger)
    if device is None:
        return entities
    registry = er.async_get(hass)
    entries = er.async_entries_for_device(registry, device, include_disabled_entities=True)
    for key, (domain, component, object_id) in OUREO_ENTITIES.items():
        for entry in entries:
            if _matches(entry, domain, component, object_id):
                entities[key] = entry.entity_id
                break
    return entities
