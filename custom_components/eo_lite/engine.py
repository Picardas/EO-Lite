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

import asyncio
from collections.abc import Callable
import logging
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.const import (
    ATTR_ENTITY_ID,
    SERVICE_TURN_OFF,
    SERVICE_TURN_ON,
    STATE_OFF,
    STATE_ON,
    STATE_UNAVAILABLE,
)
from homeassistant.core import Context, Event, EventStateChangedData, HomeAssistant, State, callback
from homeassistant.exceptions import HomeAssistantError
from homeassistant.helpers import entity_registry as er, issue_registry as ir
from homeassistant.helpers.device_registry import DeviceEntryType, DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import async_track_state_change_event
from homeassistant.helpers.start import async_at_started
from homeassistant.helpers.storage import Store

from . import charger as charger_lookup
from .const import (
    ALLOW_CHARGING,
    CONF_CHARGER,
    CONF_DASHBOARD,
    CONF_DEVICE,
    DOMAIN,
    ISSUE_CHARGER_NOT_FOUND,
    NAME,
    ONLY_DURING_TIMERS,
    STORAGE_KEY,
    STORAGE_VERSION,
    SWITCHES,
)

_LOGGER = logging.getLogger(__name__)

type EoLiteConfigEntry = ConfigEntry[EoLite]

# Sent (with the EoLite) as EO-Lite starts and when the charger's entities or
# timers change, for open dashboards.
SIGNAL_CHARGER = f"{DOMAIN}_charger"

# Seconds after a change before it's written to disk.
SAVE_DELAY = 1


@callback
def async_get_loaded(hass: HomeAssistant) -> EoLite | None:
    """The running EO-Lite, if it's set up."""
    entries: list[EoLiteConfigEntry] = hass.config_entries.async_loaded_entries(DOMAIN)
    return entries[0].runtime_data if entries else None


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
    """Runs EO-Lite's config entry."""

    def __init__(self, hass: HomeAssistant, entry: EoLiteConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.charger: str = entry.data[CONF_CHARGER]
        # openeo's id for the charger, and the charger's entities EO-Lite
        # uses and its timers (see charger.py).
        self.device = self._device()
        self.charger_entities, self.timers = charger_lookup.find(hass, self.charger, self.device)
        # Whether Home Assistant has started: only then is a charger that
        # can't be found raised in Repairs.
        self._started = False
        # Each toggle: on, off, or None until the charger's first seen (they
        # start as the charger is, so setting EO-Lite up doesn't change when
        # the car charges).
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
        # Stops watching the charger's switches by their current ids.
        self._untrack: Callable[[], None] | None = None

    @property
    def charging_switch(self) -> str:
        """The charger's charging switch, by its entity id now."""
        return self.charger_entities["charging_switch"]

    @property
    def timers_switch(self) -> str:
        """The charger's timers switch, by its entity id now."""
        return self.charger_entities["timers_switch"]

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
        self._track_switches()
        self._stop.append(async_at_started(self.hass, self._started_up))
        # The charger's entities coming, going or renamed (a timer added or
        # deleted, say).
        self._stop.append(
            self.hass.bus.async_listen(
                er.EVENT_ENTITY_REGISTRY_UPDATED, self._registry_changed, event_filter=self._about_charger
            )
        )
        # Dashboards open since before a reload are told again.
        async_dispatcher_send(self.hass, SIGNAL_CHARGER, self)

    @callback
    def _track_switches(self) -> None:
        """Watch the charger's switches by the entity ids they have now."""
        if self._untrack:
            self._untrack()
        self._untrack = async_track_state_change_event(
            self.hass, [self.charging_switch, self.timers_switch], self._charger_changed
        )

    @callback
    def _about_charger(self, data: er.EventEntityRegistryUpdatedData) -> bool:
        """Whether a registry change can concern the charger: an entity
        EO-Lite uses (by its new or old id), or one of openeo's for this
        charger."""
        uses = {
            *self.charger_entities.values(),
            *(
                timer[part]
                for timer in self.timers or ()
                for part in charger_lookup.TIMER_PARTS.values()
                if part in timer
            ),
        }
        if data["entity_id"] in uses or data.get("old_entity_id") in uses:
            return True
        entry = er.async_get(self.hass).async_get(data["entity_id"])
        return (
            self.device is not None
            and entry is not None
            and entry.platform == "mqtt"
            and entry.unique_id.startswith(f"{self.device}_")
        )

    @callback
    def _device(self) -> str | None:
        """openeo's id for the charger: its charging switch's while that has
        its usual name, otherwise the one remembered, so a charger whose
        entities are renamed is still found. One found by name is remembered
        (a new charger may have taken the old one's place)."""
        remembered = charger_lookup.valid_device(self.entry.data.get(CONF_DEVICE))
        named = charger_lookup.device_id(self.hass, self.charger)
        if named is not None and named != remembered:
            self.hass.config_entries.async_update_entry(self.entry, data={**self.entry.data, CONF_DEVICE: named})
            return named
        return remembered

    @callback
    def _registry_changed(self, _: Event) -> None:
        self.device = self._device()
        entities, timers = charger_lookup.find(self.hass, self.charger, self.device)
        if (entities, timers) != (self.charger_entities, self.timers):
            switches = (self.charging_switch, self.timers_switch)
            self.charger_entities, self.timers = entities, timers
            # One of the charger's switches renamed: it's watched, and set,
            # by its new id.
            if (self.charging_switch, self.timers_switch) != switches:
                self._track_switches()
                self._catch_up()
            async_dispatcher_send(self.hass, SIGNAL_CHARGER, self)
        self._check_found()

    @callback
    def _started_up(self, _: HomeAssistant) -> None:
        self._started = True
        self._check_found()
        self._catch_up()

    @callback
    def _check_found(self) -> None:
        """Once Home Assistant has started, a Repairs issue while neither of
        the charger's switches can be found (so the toggles can't reach the
        charger), cleared as soon as one can."""
        if not self._started:
            return
        registry = er.async_get(self.hass)
        switches = (self.charging_switch, self.timers_switch)
        if any(registry.async_get(switch) or self.hass.states.get(switch) for switch in switches):
            ir.async_delete_issue(self.hass, DOMAIN, ISSUE_CHARGER_NOT_FOUND)
        else:
            ir.async_create_issue(
                self.hass,
                DOMAIN,
                ISSUE_CHARGER_NOT_FOUND,
                is_fixable=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key=ISSUE_CHARGER_NOT_FOUND,
                translation_placeholders={"charging_switch": self.charging_switch, "timers_switch": self.timers_switch},
            )

    @callback
    def async_stop(self) -> None:
        if self._untrack:
            self._untrack()
            self._untrack = None
        while self._stop:
            self._stop.pop()()

    @callback
    def _catch_up(self, _: HomeAssistant | None = None) -> None:
        if self.settings[ALLOW_CHARGING] is None:
            self._adopt()
        else:
            self._apply_soon()

    # ---- The toggles -------------------------------------------------------

    @callback
    def async_set(self, key: str, on: bool, context: Context | None = None) -> None:
        """A toggle switched on or off: the charger follows, in a context
        whose parent is `context`, so the logbook says who switched it."""
        if self.settings[ALLOW_CHARGING] is None:
            # Switched before the charger's ever been seen: both start off.
            self.settings = dict.fromkeys(SWITCHES, False)
        self.settings[key] = on
        self._changed(context)

    @callback
    def _changed(self, context: Context | None = None) -> None:
        self._save()
        for listener in self.listeners:
            listener()
        self._apply_soon(parent=context)

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
        so a change made somewhere else is left alone, but a switch that's
        back after being unreachable is set again: it may have missed a
        toggle. Only that switch is: the other was set when it was back."""
        if event.data["old_state"] is None or event.data["new_state"] is None:
            # It's appeared or gone.
            self._check_found()
        if not _answering(event.data["new_state"]):
            return
        if self.settings[ALLOW_CHARGING] is None:
            self._adopt()
        elif not _answering(event.data["old_state"]):
            self._apply_soon(only=event.data["entity_id"])

    @callback
    def _apply_soon(self, *, only: str | None = None, parent: Context | None = None) -> None:
        self.entry.async_create_task(self.hass, self.async_apply(only=only, parent=parent), f"{DOMAIN} apply")

    async def async_apply(self, *, only: str | None = None, parent: Context | None = None) -> None:
        """Set the charger's switches from the toggles, or just the switch
        `only` when it's given, as caused by `parent` (a toggle switched;
        none for catching up). Off comes before on, so the charger's never
        told to charge both ways at once. A switch that's unreachable is
        skipped: it's set when it's back."""
        async with self._applying:
            allow = self.settings[ALLOW_CHARGING]
            if allow is None:
                return
            timed = bool(self.settings[ONLY_DURING_TIMERS])
            wanted = {self.charging_switch: allow and not timed, self.timers_switch: allow and timed}
            for entity_id, on in sorted(wanted.items(), key=lambda item: item[1]):
                if only is not None and entity_id != only:
                    continue
                state = self.hass.states.get(entity_id)
                if state is None or state.state == STATE_UNAVAILABLE:
                    continue
                try:
                    await self.hass.services.async_call(
                        "switch",
                        SERVICE_TURN_ON if on else SERVICE_TURN_OFF,
                        {ATTR_ENTITY_ID: entity_id},
                        blocking=True,
                        # For the logbook, who switched the toggle. Best effort: an apply
                        # sends the latest toggles, which may include a later switch.
                        context=Context(parent_id=parent.id if parent else None),
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
