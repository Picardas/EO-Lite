"""The core: remembering the Oureo charger, watching its entities in the
registry, and tracking whether the Charger dashboard has been added."""

from collections.abc import Callable
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Event, HomeAssistant, callback
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.storage import Store

from . import charger as charger_lookup
from .const import CONF_CHARGER, CONF_DASHBOARD, CONF_DEVICE, DOMAIN, STORAGE_KEY, STORAGE_VERSION

type EoLiteConfigEntry = ConfigEntry[EoLite]

# Sent (with the EoLite) as EO-Lite starts and when the charger's entities
# change in the registry, for open dashboards.
SIGNAL_CHARGER = f"{DOMAIN}_charger"

# Seconds after a change before it's written to disk.
SAVE_DELAY = 1


@callback
def async_get_loaded(hass: HomeAssistant) -> EoLite | None:
    """The running EO-Lite, if it's set up."""
    entries: list[EoLiteConfigEntry] = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


def _stored(data: Any) -> dict[str, Any]:
    """What was saved, leaving out anything damaged or unexpected."""
    data = data if isinstance(data, dict) else {}
    return {"dashboard_added": data.get("dashboard_added") is True}


class EoLite:
    """Runs EO-Lite's config entry."""

    def __init__(self, hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.charger: str = entry.data[CONF_CHARGER]
        self.device = self._device()
        self.charger_entities = charger_lookup.find(hass, self.charger, self.device)
        self.use_dashboard: bool = entry.options.get(CONF_DASHBOARD, True)
        self.dashboard_added = False
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._stop: list[Callable[[], None]] = []

    # ---- Stored data -------------------------------------------------------

    async def async_load(self) -> None:
        data = _stored(await self._store.async_load())
        self.dashboard_added = data["dashboard_added"] and self.use_dashboard

    @callback
    def _data(self) -> dict[str, Any]:
        return {"dashboard_added": self.dashboard_added}

    @callback
    def _save(self) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY)

    async def async_save(self) -> None:
        await self._store.async_save(self._data())

    # ---- Starting and stopping ---------------------------------------------

    @callback
    def async_start(self) -> None:
        """Watch the entity registry for the charger's entities coming, going,
        or being renamed, and notify open dashboards."""
        self._stop.append(
            self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, self._registry_changed, event_filter=self._about_charger
            )
        )
        async_dispatcher_send(self.hass, SIGNAL_CHARGER, self)

    @callback
    def _about_charger(self, data: er.EventEntityRegistryUpdatedData) -> bool:
        """Whether a registry change concerns the charger."""
        uses = set(self.charger_entities.values())
        if data["entity_id"] in uses or data.get("old_entity_id") in uses:
            return True
        entry = er.async_get(self.hass).async_get(data["entity_id"])
        return self.device is not None and entry is not None and entry.device_id == self.device

    @callback
    def _device(self) -> str | None:
        """Home Assistant's device id for the charger: from its charge_mode
        select while that has its usual name, otherwise the one remembered."""
        remembered = charger_lookup.valid_device(self.entry.data.get(CONF_DEVICE))
        named = charger_lookup.device_id(self.hass, self.charger)
        if named is not None and named != remembered:
            self.hass.config_entries.async_update_entry(self.entry, data={**self.entry.data, CONF_DEVICE: named})
            return named
        return remembered

    @callback
    def _registry_changed(self, _: Event) -> None:
        self.device = self._device()
        entities = charger_lookup.find(self.hass, self.charger, self.device)
        if entities != self.charger_entities:
            self.charger_entities = entities
            async_dispatcher_send(self.hass, SIGNAL_CHARGER, self)

    @callback
    def async_stop(self) -> None:
        while self._stop:
            self._stop.pop()()

    # ---- The dashboard -----------------------------------------------------

    @callback
    def claim_dashboard(self, release: bool = False) -> bool:
        """Whether the browser asking should add the Charger dashboard: the
        first to ask while it's wanted and not yet added. `release` gives
        that back, when adding it failed."""
        if release:
            claimed = False
            changed = self.dashboard_added
        else:
            claimed = changed = self.use_dashboard and not self.dashboard_added
        if changed:
            self.dashboard_added = not release
            self._save()
        return claimed
