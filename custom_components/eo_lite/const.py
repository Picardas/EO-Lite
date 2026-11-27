"""Constants for EO-Lite."""

from typing import Final

DOMAIN: Final = "eo_lite"
NAME: Final = "EO-Lite"

STORAGE_KEY: Final = DOMAIN
STORAGE_VERSION: Final = 1

# The charger: the start of its entity ids (eo_mini_pro_2, for
# select.eo_mini_pro_2_charge_mode and the rest).
CONF_CHARGER: Final = "charger"
# Home Assistant's device id for the ESPHome charger, so renamed entities
# are still found.
CONF_DEVICE: Final = "device"
# Whether to add the Charger dashboard.
CONF_DASHBOARD: Final = "dashboard"

# All 29 Oureo entities from HOMEASSISTANT_API.md:
# key -> (ha_domain, esphome_component_type, object_id).
OUREO_ENTITIES: Final[dict[str, tuple[str, str, str]]] = {
    # Controls (9)
    "charge_mode": ("select", "select", "charge_mode"),
    "timer_1_enabled": ("switch", "switch", "timer_1_enabled"),
    "timer_1_start": ("time", "time", "timer_1_start"),
    "timer_1_end": ("time", "time", "timer_1_end"),
    "timer_2_enabled": ("switch", "switch", "timer_2_enabled"),
    "timer_2_start": ("time", "time", "timer_2_start"),
    "timer_2_end": ("time", "time", "timer_2_end"),
    "mains_voltage_correction": ("number", "number", "mains_voltage_correction"),
    "reset_bridge": ("button", "button", "reset_bridge"),
    # Electrical & Energy Sensors (7)
    "charger_state": ("sensor", "text_sensor", "charger_state"),
    "current": ("sensor", "sensor", "current"),
    "voltage": ("sensor", "sensor", "voltage"),
    "power": ("sensor", "sensor", "power"),
    "frequency": ("sensor", "sensor", "frequency"),
    "session_energy": ("sensor", "sensor", "session_energy"),
    "energy_total": ("sensor", "sensor", "energy_total"),
    # Binary Sensors (6)
    "cable_connected": ("binary_sensor", "binary_sensor", "cable_connected"),
    "vehicle_connected": ("binary_sensor", "binary_sensor", "vehicle_connected"),
    "charging_active": ("binary_sensor", "binary_sensor", "charging_active"),
    "mains_fault": ("binary_sensor", "binary_sensor", "mains_fault"),
    "controller_connected": ("binary_sensor", "binary_sensor", "controller_connected"),
    "clock_synced": ("binary_sensor", "binary_sensor", "clock_synced"),
    # Diagnostic Sensors (7)
    "cpu_temperature": ("sensor", "sensor", "cpu_temperature"),
    "wifi_rssi": ("sensor", "sensor", "wifi_rssi"),
    "rs485_errors": ("sensor", "sensor", "rs485_errors"),
    "eo_firmware_version": ("sensor", "text_sensor", "eo_firmware_version"),
    "hw_max_current": ("sensor", "sensor", "hw_max_current"),
    "watchdog_timeout": ("sensor", "sensor", "watchdog_timeout"),
    "watchdog_current": ("sensor", "sensor", "watchdog_current"),
}


def charger_entities(charger: str) -> dict[str, str]:
    """The Oureo ESPHome entities that EO-Lite uses, by object_id."""
    return {key: f"{domain}.{charger}_{object_id}" for key, (domain, _, object_id) in OUREO_ENTITIES.items()}
