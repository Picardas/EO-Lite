"""Fixtures and helpers: a stand-in charger, and EO-Lite set up for it."""

from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, UrlManager
from homeassistant.const import EVENT_CALL_SERVICE
from homeassistant.core import Event, HomeAssistant
from homeassistant.helpers import entity_registry as er
from homeassistant.setup import async_setup_component

from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, DOMAIN
from custom_components.eo_lite.engine import EoLite

CHARGING = "switch.openeo_charger_charging"
TIMERS = "switch.openeo_charger_timers"
ALLOW = "switch.eo_lite_allow_charging"
ONLY_TIMERS = "switch.eo_lite_only_during_timers"


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Let Home Assistant load custom_components/."""


@pytest.fixture(autouse=True)
def no_frontend(hass: HomeAssistant) -> None:
    """Stand-ins for the frontend and http server (which need the frontend's
    own package), keeping the frontend's list of extra scripts."""
    hass.config.components.update({"http", "frontend"})
    hass.http = Mock(async_register_static_paths=AsyncMock())
    hass.data[DATA_EXTRA_MODULE_URL] = UrlManager(lambda *_: None, [])


class Charger:
    """A stand-in for the charger as it behaves: two real switches, either of
    which allows charging by itself. `calls` are the commands it's been sent."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.calls: list[tuple[str, str]] = []
        hass.bus.async_listen(EVENT_CALL_SERVICE, self._called)

    def _called(self, event: Event) -> None:
        if event.data["domain"] != "switch":
            return
        ids = event.data["service_data"].get("entity_id", [])
        for entity_id in [ids] if isinstance(ids, str) else ids:
            if entity_id in (CHARGING, TIMERS):
                self.calls.append((event.data["service"], entity_id))

    def on(self, entity_id: str) -> bool:
        return self.hass.states.get(entity_id).state == "on"

    def charges(self, in_timer: bool) -> bool:
        """Whether the car would charge, during one of its timers or outside them."""
        return self.on(CHARGING) or (self.on(TIMERS) and in_timer)

    async def set(self, *, charging: bool | None = None, timers: bool | None = None) -> None:
        """Its switches changed somewhere other than EO-Lite."""
        for name, on in (("charging", charging), ("timers", timers)):
            if on is not None:
                await self._boolean(name, on)

    async def reachable(self, reachable: bool) -> None:
        await self._boolean("reachable", reachable)

    async def _boolean(self, name: str, on: bool) -> None:
        await self.hass.services.async_call(
            "input_boolean", "turn_on" if on else "turn_off", {"entity_id": f"input_boolean.charger_{name}"}, blocking=True
        )
        await self.hass.async_block_till_done()


async def add_charger(hass: HomeAssistant, charging: bool = False, timers: bool = False) -> Charger:
    """A charger with its switches as given, there from now."""
    charger = Charger(hass)
    booleans = {"charger_charging": charging, "charger_timers": timers, "charger_reachable": True}
    assert await async_setup_component(
        hass, "input_boolean", {"input_boolean": {name: {"initial": on} for name, on in booleans.items()}}
    )

    def switch(name: str) -> dict[str, Any]:
        target = {"target": {"entity_id": f"input_boolean.charger_{name}"}}
        return {
            "name": f"openeo_charger_{name}",
            "state": f"{{{{ is_state('input_boolean.charger_{name}', 'on') }}}}",
            "availability": "{{ is_state('input_boolean.charger_reachable', 'on') }}",
            "turn_on": [{"action": "input_boolean.turn_on", **target}],
            "turn_off": [{"action": "input_boolean.turn_off", **target}],
        }

    assert await async_setup_component(hass, "template", {"template": [{"switch": [switch("charging"), switch("timers")]}]})
    await hass.async_block_till_done()
    return charger


class Openeo:
    """A stand-in for the charger as openeo puts it in Home Assistant: its two
    switches registered by MQTT discovery under openeo's own ids, so they can
    be renamed, answering commands by whatever entity ids they have now."""

    DEVICE = "openeo_charger_1"

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.registry = er.async_get(hass)
        # Each switch's entity id now, by openeo's name for it.
        self.ids = {"charging": CHARGING, "timers_switch": TIMERS}
        self._missed: dict[str, str] = {}
        self._register()
        hass.bus.async_listen(EVENT_CALL_SERVICE, self._called)

    def _register(self) -> None:
        for name, entity_id in self.ids.items():
            entry = self.registry.async_get_or_create(
                "switch", "mqtt", f"{self.DEVICE}_{name}", suggested_object_id=entity_id.split(".")[1]
            )
            assert entry.entity_id == entity_id
            self.hass.states.async_set(entity_id, "off")

    def _called(self, event: Event) -> None:
        if event.data["domain"] != "switch":
            return
        ids = event.data["service_data"].get("entity_id", [])
        for entity_id in [ids] if isinstance(ids, str) else ids:
            if entity_id in self.ids.values() and not self._missed:
                self.hass.states.async_set(entity_id, "on" if event.data["service"] == "turn_on" else "off")

    def on(self, name: str) -> bool:
        return self.hass.states.get(self.ids[name]).state == "on"

    def charges(self, in_timer: bool) -> bool:
        """Whether the car would charge, during one of its timers or outside them."""
        return self.on("charging") or (self.on("timers_switch") and in_timer)

    async def rename(self, name: str, entity_id: str) -> None:
        """One of its switches renamed in Settings: it's back under its new id."""
        old = self.ids[name]
        state = self.hass.states.get(old).state
        self.registry.async_update_entity(old, new_entity_id=entity_id)
        self.hass.states.async_remove(old)
        self.hass.states.async_set(entity_id, state)
        self.ids[name] = entity_id
        await self.hass.async_block_till_done()

    async def gone(self) -> None:
        """Its integration's removed: its switches leave Home Assistant."""
        for entity_id in self.ids.values():
            self.hass.states.async_remove(entity_id)
            self.registry.async_remove(entity_id)
        await self.hass.async_block_till_done()

    async def back(self) -> None:
        """Its integration's set up again: its switches are back, off."""
        self._register()
        await self.hass.async_block_till_done()

    async def reachable(self, reachable: bool) -> None:
        """Off the network its switches are unavailable, and it hears nothing;
        back, they say what they were."""
        if reachable:
            missed, self._missed = self._missed, {}
            for entity_id, state in missed.items():
                self.hass.states.async_set(entity_id, state)
        else:
            self._missed = {entity_id: self.hass.states.get(entity_id).state for entity_id in self.ids.values()}
            for entity_id in self._missed:
                self.hass.states.async_set(entity_id, "unavailable")
        await self.hass.async_block_till_done()


async def add_openeo(hass: HomeAssistant) -> Openeo:
    """A charger as openeo registers it, with both its switches off."""
    # Its switches answer the switch actions, which come with Home Assistant's
    # switch integration.
    assert await async_setup_component(hass, "switch", {})
    return Openeo(hass)


@pytest.fixture
async def charger(hass: HomeAssistant) -> Charger:
    """A charger with both its switches off."""
    charger = await add_charger(hass)
    assert hass.states.get(CHARGING).state == "off"
    assert hass.states.get(TIMERS).state == "off"
    return charger


@pytest.fixture
def entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN, title="EO-Lite", data={CONF_CHARGER: "openeo_charger"}, options={CONF_DASHBOARD: True}, minor_version=2
    )


@pytest.fixture
async def eo_lite(hass: HomeAssistant, charger: Charger, entry: MockConfigEntry) -> EoLite:
    return await set_up(hass, entry)


# ---- Helpers ------------------------------------------------------------------


async def set_up(hass: HomeAssistant, entry: MockConfigEntry) -> EoLite:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry.runtime_data


async def toggle(hass: HomeAssistant, entity_id: str, on: bool) -> None:
    """Switch one of EO-Lite's toggles, as the dashboard does."""
    await hass.services.async_call("switch", "turn_on" if on else "turn_off", {"entity_id": entity_id}, blocking=True)
    await hass.async_block_till_done()


def is_on(hass: HomeAssistant, entity_id: str) -> bool:
    return hass.states.get(entity_id).state == "on"


def ws(hass: HomeAssistant, handler: Any, msg: dict[str, Any], connection: Mock | None = None) -> Mock:
    """Call a websocket command as an admin's dashboard would, checked
    against its schema as Home Assistant checks it; the connection records
    what's sent back."""
    connection = connection or Mock(user=Mock(is_admin=True), subscriptions={})
    msg = {"id": 1, **msg}
    # Commands with no fields of their own have no schema.
    handler(hass, connection, handler._ws_schema(msg) if handler._ws_schema else msg)
    return connection
