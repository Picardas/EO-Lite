"""The core: the two charging toggles, kept across restarts, and setting the
charger's own switches from them.

The charger's switches each allow charging by themselves: one charges now,
the other charges during the timers even with the first off. So neither is
an overall "allow charging". EO-Lite's toggles are, and the charger's
switches follow them:

    Allow charging   Only during timers   charging switch   timers switch
    off              (either)             off               off
    on               off                  on                off
    on               on                   off               on
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry, ConfigEntryState
from homeassistant.const import (
    ATTR_ENTITY_ID,
    EVENT_HOMEASSISTANT_STARTED,
    SERVICE_TURN_OFF,
    SERVICE_TURN_ON,
    STATE_OFF,
    STATE_ON,
    STATE_UNAVAILABLE,
)
from homeassistant.core import Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.storage import Store

from .const import (
    ALLOW_CHARGING,
    CONF_CHARGER,
    CONF_DASHBOARD,
    DOMAIN,
    NAME,
    ONLY_DURING_TIMERS,
    STORAGE_KEY,
    STORAGE_VERSION,
    SWITCHES,
    charger_entities,
)

_LOGGER = logging.getLogger(__name__)

type EoLiteConfigEntry = ConfigEntry[EoLite]

# How long after a change before it's written to disk.
SAVE_DELAY = 1


@callback
def async_get_loaded(hass: HomeAssistant) -> EoLite | None:
    """The running EO-Lite, if it's set up."""
    for entry in hass.config_entries.async_entries(DOMAIN):
        if entry.state is ConfigEntryState.LOADED:
            return entry.runtime_data
    return None


def _answering(state: State | None) -> bool:
    """Whether a charger switch is saying on or off."""
    return state is not None and state.state in (STATE_ON, STATE_OFF)


def _stored(data: Any) -> dict[str, Any]:
    """What was saved, with anything that isn't as it should be left out (a
    damaged file): each toggle on, off or not known yet, and whether the
    dashboard's been added."""
    data = data if isinstance(data, dict) else {}
    settings = {key: data[key] if isinstance(data.get(key), bool) else None for key in SWITCHES}
    if settings[ALLOW_CHARGING] is None:
        settings[ONLY_DURING_TIMERS] = None
    elif settings[ONLY_DURING_TIMERS] is None:
        settings[ONLY_DURING_TIMERS] = False
    return {"settings": settings, "dashboard_added": data.get("dashboard_added") is True}


class EoLite:
    def __init__(self, hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.charger: str = entry.data[CONF_CHARGER]
        self.charger_entities = charger_entities(self.charger)
        self.charging_switch = self.charger_entities["charging_switch"]
        self.timers_switch = self.charger_entities["timers_switch"]
        # Each toggle: on, off, or None until the charger's first seen (they
        # start as the charger is, so setting EO-Lite up changes nothing).
        self.settings: dict[str, bool | None] = dict.fromkeys(SWITCHES)
        self.use_dashboard: bool = entry.options.get(CONF_DASHBOARD, True)
        self.dashboard_added = False
        # EO-Lite's own entity ids, by key, for the dashboard.
        self.entity_ids: dict[str, str] = {}
        self.device_info = DeviceInfo(identifiers={(DOMAIN, entry.entry_id)}, name=NAME, entry_type=DeviceEntryType.SERVICE)
        # Called when a toggle changes, so its entity shows it.
        self.listeners: list[Callable[[], None]] = []
        self._store: Store[dict[str, Any]] = Store(hass, STORAGE_VERSION, STORAGE_KEY)
        self._applying = asyncio.Lock()
        self._stop: list[Callable[[], None]] = []

    # ---- Stored data -------------------------------------------------------

    async def async_load(self) -> None:
        data = _stored(await self._store.async_load())
        self.settings = data["settings"]
        self.dashboard_added = data["dashboard_added"] and self.use_dashboard

    @callback
    def _data(self) -> dict[str, Any]:
        return {**self.settings, "dashboard_added": self.dashboard_added}

    @callback
    def _save(self) -> None:
        self._store.async_delay_save(self._data, SAVE_DELAY)

    async def async_save(self) -> None:
        await self._store.async_save(self._data())

    # ---- Starting and stopping ---------------------------------------------

    @callback
    def async_start(self) -> None:
        """Watch the charger's switches, and set them from the toggles now
        (or once Home Assistant has started, when the charger's there)."""
        self._stop.append(
            async_track_state_change_event(self.hass, [self.charging_switch, self.timers_switch], self._charger_changed)
        )
        if self.hass.is_running:
            self._catch_up()
        else:
            self._stop.append(self.hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, self._catch_up))

    @callback
    def async_stop(self) -> None:
        while self._stop:
            self._stop.pop()()

    @callback
    def _catch_up(self, _: Event | None = None) -> None:
        if self.settings[ALLOW_CHARGING] is None:
            self._adopt()
        else:
            self._apply_soon()

    # ---- The toggles -------------------------------------------------------

    @callback
    def async_set(self, key: str, on: bool) -> None:
        """A toggle switched on or off: the charger follows."""
        if self.settings[ALLOW_CHARGING] is None:
            # Switched before the charger's ever been seen: both start off.
            self.settings = dict.fromkeys(SWITCHES, False)
        self.settings[key] = on
        self._changed()

    @callback
    def _changed(self) -> None:
        self._save()
        for listener in self.listeners:
            listener()
        self._apply_soon()

    @callback
    def _adopt(self) -> None:
        """The first time the charger's seen, the toggles start as it is:
        allowed if either of its switches is on, and only during timers if
        that's all that's on."""
        charging, timers = self.hass.states.get(self.charging_switch), self.hass.states.get(self.timers_switch)
        if not (_answering(charging) and _answering(timers)):
            return
        charges_now, charges_in_timers = charging.state == STATE_ON, timers.state == STATE_ON
        self.settings = {
            ALLOW_CHARGING: charges_now or charges_in_timers,
            ONLY_DURING_TIMERS: charges_in_timers and not charges_now,
        }
        self._changed()

    # ---- The charger -------------------------------------------------------

    @callback
    def _charger_changed(self, event: Event[EventStateChangedData]) -> None:
        """One of the charger's switches changed. The toggles are in charge,
        so a change made somewhere else is left alone, but a charger that's
        back after being unreachable is set again: it may have missed a
        toggle."""
        if not _answering(event.data["new_state"]):
            return
        if self.settings[ALLOW_CHARGING] is None:
            self._adopt()
        elif not _answering(event.data["old_state"]):
            self._apply_soon()

    @callback
    def _apply_soon(self) -> None:
        self.entry.async_create_task(self.hass, self.async_apply(), f"{DOMAIN} apply")

    async def async_apply(self) -> None:
        """Set the charger's switches from the toggles. Off comes before on,
        so the charger's never told to charge both ways at once. A switch
        that's unreachable is skipped: it's set when it's back."""
        async with self._applying:
            allow = self.settings[ALLOW_CHARGING]
            if allow is None:
                return
            timed = bool(self.settings[ONLY_DURING_TIMERS])
            wanted = {self.charging_switch: allow and not timed, self.timers_switch: allow and timed}
            for entity_id, on in sorted(wanted.items(), key=lambda item: item[1]):
                state = self.hass.states.get(entity_id)
                if state is None or state.state == STATE_UNAVAILABLE:
                    continue
                try:
                    await self.hass.services.async_call(
                        "switch", SERVICE_TURN_ON if on else SERVICE_TURN_OFF, {ATTR_ENTITY_ID: entity_id}, blocking=True
                    )
                except HomeAssistantError as err:
                    _LOGGER.warning("Couldn't switch %s %s: %s", entity_id, "on" if on else "off", err)

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
