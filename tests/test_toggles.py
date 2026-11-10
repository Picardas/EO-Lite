"""Allow charging and Only during timers, and the charger following them."""

from __future__ import annotations

from typing import Any

from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.core import CoreState, HomeAssistant

from custom_components.eo_lite.const import DOMAIN
from custom_components.eo_lite.engine import EoLite

from .conftest import ALLOW, CHARGING, ONLY_TIMERS, TIMERS, Charger, add_charger, is_on, set_up, toggle


async def test_allow_off_never_charges(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    # Charging is allowed, then not.
    await toggle(hass, ALLOW, True)
    await toggle(hass, ALLOW, False)
    # Nothing charges the car, in a timer or out of one.
    assert not charger.charges(in_timer=False)
    assert not charger.charges(in_timer=True)


async def test_only_during_timers_does_not_override_allow(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    # With charging not allowed, Only during timers is switched on.
    await toggle(hass, ONLY_TIMERS, True)
    # The timers still can't charge the car.
    assert not is_on(hass, ALLOW)
    assert not charger.charges(in_timer=True)
    assert not charger.charges(in_timer=False)


async def test_allow_with_only_during_timers_waits_for_a_timer(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    # Only during timers is set first, then charging is allowed.
    await toggle(hass, ONLY_TIMERS, True)
    await toggle(hass, ALLOW, True)
    # It doesn't charge straight away, only in a timer.
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)
    # The charger was never told to charge now along the way.
    assert ("turn_on", CHARGING) not in charger.calls


async def test_allow_alone_charges_any_time(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    await toggle(hass, ALLOW, True)
    assert charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)
    # The timers switch is left off: they'd add nothing.
    assert not charger.on(TIMERS)


async def test_switching_between_any_time_and_timers(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    await toggle(hass, ALLOW, True)
    assert charger.charges(in_timer=False)
    # Only during timers on: charging now stops.
    await toggle(hass, ONLY_TIMERS, True)
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)
    # Off was sent before on, so it was never told to charge both ways.
    assert charger.calls[-2:] == [("turn_off", CHARGING), ("turn_on", TIMERS)]
    # And off again: any time.
    await toggle(hass, ONLY_TIMERS, False)
    assert charger.charges(in_timer=False)


async def test_only_during_timers_is_remembered_while_not_allowed(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    await toggle(hass, ONLY_TIMERS, True)
    await toggle(hass, ALLOW, True)
    # Not allowed for a while, then allowed again.
    await toggle(hass, ALLOW, False)
    await toggle(hass, ALLOW, True)
    # It's still only during timers.
    assert is_on(hass, ONLY_TIMERS)
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)


# ---- Starting as the charger is ----------------------------------------------


async def test_first_set_up_starts_as_the_charger_is_charging_now(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    # The charger's charging now, with its timers on too.
    charger = await add_charger(hass, charging=True, timers=True)
    await set_up(hass, entry)
    # Charging's allowed, at any time: what it was doing.
    assert is_on(hass, ALLOW)
    assert not is_on(hass, ONLY_TIMERS)
    assert charger.charges(in_timer=False)
    # It was never told to stop.
    assert ("turn_off", CHARGING) not in charger.calls


async def test_first_set_up_starts_as_the_charger_is_on_timers(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    charger = await add_charger(hass, timers=True)
    await set_up(hass, entry)
    assert is_on(hass, ALLOW)
    assert is_on(hass, ONLY_TIMERS)
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)


async def test_first_set_up_starts_as_the_charger_is_off(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    charger = await add_charger(hass)
    await set_up(hass, entry)
    assert not is_on(hass, ALLOW)
    assert not is_on(hass, ONLY_TIMERS)
    assert not charger.charges(in_timer=True)


async def test_set_up_before_the_charger_is_there(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    # EO-Lite's set up while the charger's integration isn't loaded.
    await set_up(hass, entry)
    # The toggles aren't on or off yet.
    assert hass.states.get(ALLOW).state == "unknown"
    assert hass.states.get(ONLY_TIMERS).state == "unknown"
    # The charger appears, on its timers: the toggles start as it is.
    charger = await add_charger(hass, timers=True)
    await hass.async_block_till_done()
    assert is_on(hass, ALLOW)
    assert is_on(hass, ONLY_TIMERS)
    assert charger.charges(in_timer=True)


async def test_a_toggle_switched_before_the_charger_is_there(hass: HomeAssistant, entry: MockConfigEntry) -> None:
    await set_up(hass, entry)
    # Allow charging is switched on with no charger yet.
    await toggle(hass, ALLOW, True)
    assert is_on(hass, ALLOW)
    assert not is_on(hass, ONLY_TIMERS)
    # The charger appears, off: it's told to charge, as the toggle says.
    charger = await add_charger(hass)
    await hass.async_block_till_done()
    assert charger.charges(in_timer=False)


# ---- Keeping the charger to the toggles ---------------------------------------


async def test_catches_up_when_the_charger_comes_back(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    await toggle(hass, ALLOW, True)
    assert charger.charges(in_timer=False)
    # The charger drops off the network, and charging is switched off meanwhile: it doesn't hear.
    await charger.reachable(False)
    await toggle(hass, ALLOW, False)
    assert charger.calls[-1][0] == "turn_on"
    # It comes back, still charging: it's told, and stops.
    await charger.reachable(True)
    assert not charger.charges(in_timer=False)
    assert not charger.charges(in_timer=True)


async def test_a_change_on_the_charger_itself_is_left_alone(hass: HomeAssistant, charger: Charger, eo_lite: EoLite) -> None:
    await toggle(hass, ALLOW, True)
    sent = len(charger.calls)
    # Its timers switch is turned on somewhere else.
    await charger.set(timers=True)
    # EO-Lite doesn't fight it, and its toggles stay as they were.
    assert len(charger.calls) == sent
    assert charger.on(TIMERS)
    assert not is_on(hass, ONLY_TIMERS)


async def test_toggles_are_kept_and_set_again_after_a_restart(
    hass: HomeAssistant, charger: Charger, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    await set_up(hass, entry)
    await toggle(hass, ONLY_TIMERS, True)
    await toggle(hass, ALLOW, True)
    # Home Assistant stops; meanwhile the charger's told to charge now by something else.
    assert await hass.config_entries.async_unload(entry.entry_id)
    assert hass_storage[DOMAIN]["data"] == {"allow_charging": True, "only_during_timers": True, "dashboard_added": False}
    await charger.set(charging=True)
    # Back up, the toggles are as they were, and the charger's put back to them.
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    assert is_on(hass, ALLOW)
    assert is_on(hass, ONLY_TIMERS)
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)


async def test_waits_for_home_assistant_to_start(hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any]) -> None:
    # Charging isn't allowed, but the charger's charging as Home Assistant starts.
    hass_storage[DOMAIN] = {"version": 1, "key": DOMAIN, "data": {"allow_charging": False, "only_during_timers": False}}
    hass.set_state(CoreState.not_running)
    charger = await add_charger(hass, charging=True)
    await set_up(hass, entry)
    # Nothing's sent while it's starting (the charger's integration may not be up).
    assert charger.calls == []
    await hass.async_start()
    await hass.async_block_till_done()
    # Once it has, the charger's set from the toggles.
    assert not charger.charges(in_timer=False)


async def test_damaged_stored_data_is_left_out(hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any]) -> None:
    # What was saved isn't toggles at all.
    hass_storage[DOMAIN] = {
        "version": 1,
        "key": DOMAIN,
        "data": {"allow_charging": "yes", "only_during_timers": True, "dashboard_added": "no"},
    }
    charger = await add_charger(hass, charging=True)
    eo_lite = await set_up(hass, entry)
    # The toggles start as the charger is instead, and the dashboard isn't thought added.
    assert is_on(hass, ALLOW)
    assert not is_on(hass, ONLY_TIMERS)
    assert eo_lite.dashboard_added is False
    assert charger.charges(in_timer=False)


async def test_removing_eo_lite_forgets_the_toggles(
    hass: HomeAssistant, charger: Charger, entry: MockConfigEntry, hass_storage: dict[str, Any]
) -> None:
    await set_up(hass, entry)
    await toggle(hass, ALLOW, True)
    assert await hass.config_entries.async_remove(entry.entry_id)
    await hass.async_block_till_done()
    assert DOMAIN not in hass_storage
    # The charger's left as it was.
    assert charger.charges(in_timer=False)
