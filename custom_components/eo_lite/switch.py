"""The two toggles: Allow charging, and Only during timers."""

from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import SWITCHES
from .engine import EoLite, EoLiteConfigEntry


async def async_setup_entry(
    hass: HomeAssistant, entry: EoLiteConfigEntry, async_add_entities: AddEntitiesCallback
) -> None:
    async_add_entities(Toggle(entry.runtime_data, key) for key in SWITCHES)


class Toggle(SwitchEntity):
    """A toggle: its value lives in the engine, which sets the charger from it."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, eo_lite: EoLite, key: str) -> None:
        self.eo_lite = eo_lite
        self.key = key
        self._attr_translation_key = key
        self._attr_unique_id = f"{eo_lite.entry.entry_id}_{key}"
        self._attr_device_info = eo_lite.device_info

    async def async_added_to_hass(self) -> None:
        self.eo_lite.entity_ids[self.key] = self.entity_id
        self.eo_lite.listeners.append(self.async_write_ha_state)
        self.async_on_remove(lambda: self.eo_lite.entity_ids.pop(self.key, None))
        self.async_on_remove(lambda: self.eo_lite.listeners.remove(self.async_write_ha_state))

    @property
    def is_on(self) -> bool | None:
        return self.eo_lite.settings[self.key]

    async def async_turn_on(self, **kwargs: Any) -> None:
        self.eo_lite.async_set(self.key, True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        self.eo_lite.async_set(self.key, False)
