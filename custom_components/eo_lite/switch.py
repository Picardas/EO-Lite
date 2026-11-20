"""The two toggles: Allow charging, and Only during timers."""

from typing import Any

from homeassistant.auth.permissions.const import POLICY_CONTROL
from homeassistant.components.switch import SwitchEntity
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import Unauthorized, UnknownUser
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from .const import SWITCHES
from .engine import EoLite, EoLiteConfigEntry

# Nothing polls, so Home Assistant needn't limit parallel updates.
PARALLEL_UPDATES = 0


async def async_setup_entry(
    hass: HomeAssistant, entry: EoLiteConfigEntry, async_add_entities: AddConfigEntryEntitiesCallback
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
        await self._async_switch(True)

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self._async_switch(False)

    async def _async_switch(self, on: bool) -> None:
        """Switching a toggle switches the charger, so whoever does it must
        be allowed to control the charger's own switches too, as Home
        Assistant's switch groups require of their members. EO-Lite then
        sets them as itself, which Home Assistant doesn't check."""
        context = self._context
        if context and context.user_id:
            if (user := await self.hass.auth.async_get_user(context.user_id)) is None:
                raise UnknownUser(context=context)
            for entity_id in (self.eo_lite.charging_switch, self.eo_lite.timers_switch):
                if not (user.is_admin or user.permissions.check_entity(entity_id, POLICY_CONTROL)):
                    raise Unauthorized(context=context, entity_id=entity_id, permission=POLICY_CONTROL)
        self.eo_lite.async_set(self.key, on, context)
