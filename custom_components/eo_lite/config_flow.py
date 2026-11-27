"""Setup asks two things: which Oureo charger, and whether to add the Charger
dashboard."""

import re
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
from .const import CONF_CHARGER, CONF_DASHBOARD, CONF_DEVICE, DOMAIN, NAME

CHARGER_NAME = re.compile(r"[a-z0-9_]+")
REQUIRED_MODES = {"Off", "On", "Timer"}


@callback
def chargers(hass: HomeAssistant) -> dict[str, str]:
    """The Oureo chargers present in Home Assistant, keyed by the start of
    their entity ids (`eo_mini_pro_2` for `select.eo_mini_pro_2_charge_mode`)."""
    entities, devices = er.async_get(hass), dr.async_get(hass)
    found = {}
    for state in hass.states.async_all("select"):
        object_id = state.entity_id.partition(".")[2]
        charger = object_id.removesuffix("_charge_mode")
        if charger in ("", object_id) or not CHARGER_NAME.fullmatch(charger):
            continue
        entry = entities.async_get(state.entity_id)
        is_esphome = entry is not None and entry.platform == "esphome" and entry.unique_id.endswith("-select-charge_mode")
        options = set(state.attributes.get("options") or ())
        if not (is_esphome or REQUIRED_MODES.issubset(options)):
            continue
        device = devices.async_get(entry.device_id) if entry and entry.device_id else None
        found[charger] = (device and (device.name_by_user or device.name)) or charger
    return found


class EoLiteConfigFlow(ConfigFlow, domain=DOMAIN):
    VERSION = 1
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
