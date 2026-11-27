"""EO-Lite: a Charger dashboard for an Oureo EV charger already paired with
Home Assistant's built-in ESPHome integration."""

from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.storage import Store
from homeassistant.helpers.typing import ConfigType

from . import dashboard
from .const import DOMAIN, STORAGE_KEY, STORAGE_VERSION
from .engine import EoLite, EoLiteConfigEntry

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    await dashboard.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    entry.async_on_unload(dashboard.async_add_script(hass))
    eo_lite = EoLite(hass, entry)
    await eo_lite.async_load()
    entry.runtime_data = eo_lite
    entry.async_on_unload(eo_lite.async_stop)
    eo_lite.async_start()
    return True


async def async_unload_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> bool:
    entry.runtime_data.async_stop()
    await entry.runtime_data.async_save()
    return True


async def async_remove_entry(hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
    """Forget stored dashboard state when removed."""
    await Store(hass, STORAGE_VERSION, STORAGE_KEY).async_remove()
