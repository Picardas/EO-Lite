"""Setup asks two things: which charger, and whether to add the Charger
dashboard."""

from typing import Any

import probatio as vol

from homeassistant.config_entries import ConfigFlow, ConfigFlowResult
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr, entity_registry as er
from homeassistant.helpers.selector import (
    BooleanSelector,
    SelectOptionDict,
    SelectSelector,
    SelectSelectorConfig,
    SelectSelectorMode,
)

from . import charger as charger_lookup
from .const import CONF_CHARGER, CONF_DASHBOARD, CONF_DEVICE, DOMAIN, NAME, charger_entities


@callback
def chargers(hass: HomeAssistant) -> dict[str, str]:
    """The chargers there are, by the start of their entity ids, with a
    name for each: anything with both a charging switch and a timers switch."""
    entities, devices = er.async_get(hass), dr.async_get(hass)
    found = {}
    for state in hass.states.async_all("switch"):
        object_id = state.entity_id.partition(".")[2]
        charger = object_id.removesuffix("_charging")
        if charger in ("", object_id) or hass.states.get(charger_entities(charger)["timers_switch"]) is None:
            continue
        entry = entities.async_get(state.entity_id)
        device = devices.async_get(entry.device_id) if entry and entry.device_id else None
        found[charger] = (device and (device.name_by_user or device.name)) or charger
    return found


class EoLiteConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1
    # Minor version 2 remembers openeo's id for the charger (see async_migrate_entry).
    MINOR_VERSION = 2

    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        found = chargers(self.hass)
        if not found:
            return self.async_abort(reason="no_charger")
        if user_input is not None:
            data = {CONF_CHARGER: user_input[CONF_CHARGER]}
            if device := charger_lookup.device_id(self.hass, user_input[CONF_CHARGER]):
                data[CONF_DEVICE] = device
            return self.async_create_entry(
                title=NAME,
                data=data,
                options={CONF_DASHBOARD: user_input[CONF_DASHBOARD]},
            )
        schema = vol.Schema(
            {
                vol.Required(CONF_CHARGER, default=next(iter(found))): SelectSelector(
                    SelectSelectorConfig(
                        options=[SelectOptionDict(value=charger, label=name) for charger, name in found.items()],
                        mode=SelectSelectorMode.DROPDOWN,
                    )
                ),
                vol.Required(CONF_DASHBOARD, default=True): BooleanSelector(),
            }
        )
        return self.async_show_form(step_id="user", data_schema=schema)
