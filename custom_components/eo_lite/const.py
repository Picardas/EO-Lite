"""Constants for EO-Lite."""

from __future__ import annotations

from typing import Final

DOMAIN: Final = "eo_lite"
NAME: Final = "EO-Lite"

STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1

# The charger: the start of its entity ids (openeo_charger, for
# switch.openeo_charger_charging and the rest).
CONF_CHARGER: Final = "charger"
CONF_DASHBOARD: Final = "dashboard"

# The two toggles, shown as EO-Lite's switch entities (and on the dashboard).
# Keys are the entity keys.
ALLOW_CHARGING: Final = "allow_charging"
ONLY_DURING_TIMERS: Final = "only_during_timers"
SWITCHES: Final = (ALLOW_CHARGING, ONLY_DURING_TIMERS)


def charger_entities(charger: str) -> dict[str, str]:
    """The charger integration's entities that EO-Lite uses, by what they're for."""
    return {
        # On: the charger charges now, whatever its timers say.
        "charging_switch": f"switch.{charger}_charging",
        # On: the charger charges during its timers, even with the switch above off.
        "timers_switch": f"switch.{charger}_timers",
        "state": f"sensor.{charger}_charger_state",
        "power": f"sensor.{charger}_power_delivered",
        "vehicle_current": f"sensor.{charger}_vehicle_current",
        "charging_active": f"binary_sensor.{charger}_charging_active",
        "vehicle_connected": f"binary_sensor.{charger}_vehicle_connected",
        "session_kwh": f"sensor.{charger}_session_kwh",
        "session_cost": f"sensor.{charger}_session_cost",
        "add_timer": f"button.{charger}_add_charge_schedule",
    }
