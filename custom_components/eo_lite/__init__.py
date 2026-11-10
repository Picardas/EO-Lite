"""EO-Lite: an overall Allow charging, an Only during timers that means it,
and a Charger dashboard, for an OpenEO charger already in Home Assistant."""

from __future__ import annotations

from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from . import dashboard
from .const import DOMAIN, STORAGE_KEY, STORAGE_VERSION
from .engine import EoLite, EoLiteConfigEntry

PLATFORMS = [Platform.SWITCH]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await dashboard.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    # The dashboard's script first, so pages opened while Home Assistant's
    # starting get it as soon as possible (they wait 5 seconds for it).
    entry.async_on_unload(dashboard.async_add_script(hass))
    eo_lite = EoLite(hass, entry)
    await eo_lite.async_load()
    entry.runtime_data = eo_lite
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    eo_lite.async_start()
    entry.async_on_unload(eo_lite.async_stop)
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    if unloaded := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        await entry.runtime_data.async_save()
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
    """Forget the toggles. The charger's switches stay as they are."""
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
