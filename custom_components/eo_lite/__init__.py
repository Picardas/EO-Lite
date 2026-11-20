"""EO-Lite: an overall Allow charging, an Only during timers that means it,
and a Charger dashboard, for an OpenEO charger already in Home Assistant."""

from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv, issue_registry as ir
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from . import charger as charger_lookup, dashboard
from .const import CONF_CHARGER, CONF_DEVICE, DOMAIN, ISSUE_CHARGER_NOT_FOUND, STORAGE_KEY, STORAGE_VERSION
from .engine import EoLite, EoLiteConfigEntry

PLATFORMS = [Platform.SWITCH]

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await dashboard.async_register(hass)
    return True


async def async_migrate_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    """Bring an older entry up to date. Before minor version 2 it didn't
    remember openeo's id for the charger: it's taken from the registry if the
    charger's there (or later, once it is). An entry from a later major
    version isn't loaded."""
    if entry.version > 1:
        return False
    if entry.minor_version < 2:
        data = {**entry.data}
        if device := charger_lookup.device_id(hass, entry.data[CONF_CHARGER]):
            data[CONF_DEVICE] = device
        hass.config_entries.async_update_entry(entry, data=data, minor_version=2)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    # The dashboard's script first, so pages opened while Home Assistant's
    # starting get it as soon as possible (they wait 5 seconds for it).
    entry.async_on_unload(dashboard.async_add_script(hass))
    eo_lite = EoLite(hass, entry)
    await eo_lite.async_load()
    entry.runtime_data = eo_lite
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    # Before starting, so a start that fails part-way still stops what it started.
    entry.async_on_unload(eo_lite.async_stop)
    eo_lite.async_start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    if unloaded := await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        # Stopped first, so nothing changes (and is saved again) after this save.
        entry.runtime_data.async_stop()
        await entry.runtime_data.async_save()
        ir.async_delete_issue(hass, DOMAIN, ISSUE_CHARGER_NOT_FOUND)
    return unloaded


async def async_remove_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
    """Forget the toggles, and any Repairs issue. The charger's switches
    stay as they are."""
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
    ir.async_delete_issue(hass, DOMAIN, ISSUE_CHARGER_NOT_FOUND)
