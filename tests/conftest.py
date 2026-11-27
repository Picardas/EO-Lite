"""Fixtures and helpers: a stand-in Oureo ESPHome charger, and EO-Lite set up for it."""

from typing import Any
from unittest.mock import AsyncMock, Mock

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, UrlManager
from homeassistant.core import HomeAssistant
from homeassistant.helpers import device_registry as dr, entity_registry as er

from custom_components.eo_lite.const import CONF_CHARGER, CONF_DASHBOARD, DOMAIN, OUREO_ENTITIES
from custom_components.eo_lite.engine import EoLite

CHARGER = "eo_mini_pro_2"
MAC = "aa:bb:cc:dd:ee:ff"

DEFAULT_STATES: dict[str, tuple[str, dict[str, Any]]] = {
    "charge_mode": ("Off", {"options": ["Off", "On", "Timer"]}),
    "timer_1_enabled": ("off", {}),
    "timer_1_start": ("00:30:00", {}),
    "timer_1_end": ("04:30:00", {}),
    "timer_2_enabled": ("off", {}),
    "timer_2_start": ("00:00:00", {}),
    "timer_2_end": ("00:00:00", {}),
    "mains_voltage_correction": ("77.8", {"unit_of_measurement": "%"}),
    "reset_bridge": ("unknown", {}),
    "charger_state": ("idle", {}),
    "current": ("0.0", {"unit_of_measurement": "A"}),
    "voltage": ("234.0", {"unit_of_measurement": "V"}),
    "power": ("0", {"unit_of_measurement": "W"}),
    "frequency": ("50", {"unit_of_measurement": "Hz"}),
    "session_energy": ("0.000", {"unit_of_measurement": "kWh"}),
    "energy_total": ("123.456", {"unit_of_measurement": "kWh"}),
    "cable_connected": ("off", {}),
    "vehicle_connected": ("off", {}),
    "charging_active": ("off", {}),
    "mains_fault": ("off", {}),
    "controller_connected": ("on", {}),
    "clock_synced": ("on", {}),
    "cpu_temperature": ("42.0", {"unit_of_measurement": "°C"}),
    "wifi_rssi": ("-58", {"unit_of_measurement": "dBm"}),
    "rs485_errors": ("0", {}),
    "eo_firmware_version": ("0x14", {}),
    "hw_max_current": ("0.0", {"unit_of_measurement": "A"}),
    "watchdog_timeout": ("60", {}),
    "watchdog_current": ("0", {}),
}


@pytest.fixture(autouse=True)
def auto_enable_custom_integrations(enable_custom_integrations: None) -> None:
    """Let Home Assistant load custom_components/."""


@pytest.fixture(autouse=True)
def no_frontend(hass: HomeAssistant) -> None:
    """Stand-ins for the frontend and http server, keeping extra module URLs."""
    hass.config.components.update({"http", "frontend"})
    hass.http = Mock(async_register_static_paths=AsyncMock())
    hass.data[DATA_EXTRA_MODULE_URL] = UrlManager(lambda *_: None, [])


class Oureo:
    """A stand-in for an Oureo charger registered by Home Assistant's ESPHome integration."""

    def __init__(self, hass: HomeAssistant, charger: str = CHARGER, mac: str = MAC) -> None:
        self.hass = hass
        self.charger = charger
        self.mac = mac
        self.registry = er.async_get(hass)
        self.esphome_entry = MockConfigEntry(domain="esphome", title="EO Mini Pro 2")
        self.esphome_entry.add_to_hass(hass)
        device = dr.async_get(hass).async_get_or_create(
            config_entry_id=self.esphome_entry.entry_id,
            connections={(dr.CONNECTION_NETWORK_MAC, mac)},
            name="EO Mini Pro 2",
            manufacturer="EO Charging (Oureo)",
            model="EO Mini Pro 2",
        )
        self.device_id = device.id
        self.ids: dict[str, str] = {}
        self._register()

    def _register(self) -> None:
        for key, (domain, component, object_id) in OUREO_ENTITIES.items():
            unique_id = f"{self.mac}-{component}-{object_id}"
            entry = self.registry.async_get_or_create(
                domain,
                "esphome",
                unique_id,
                suggested_object_id=f"{self.charger}_{object_id}",
                device_id=self.device_id,
            )
            self.ids[key] = entry.entity_id
            state, attrs = DEFAULT_STATES[key]
            self.hass.states.async_set(entry.entity_id, state, attrs)

    async def rename(self, key: str, new_entity_id: str) -> None:
        """Rename one of Oureo's entities in the registry."""
        old = self.ids[key]
        current = self.hass.states.get(old)
        self.registry.async_update_entity(old, new_entity_id=new_entity_id)
        if current is not None:
            self.hass.states.async_remove(old)
            self.hass.states.async_set(new_entity_id, current.state, current.attributes)
        self.ids[key] = new_entity_id
        await self.hass.async_block_till_done()


def add_simple_charger(hass: HomeAssistant, charger: str = CHARGER) -> dict[str, str]:
    """A charger with plain Home Assistant states and no registry entries."""
    ids: dict[str, str] = {}
    for key, (domain, _, object_id) in OUREO_ENTITIES.items():
        entity_id = f"{domain}.{charger}_{object_id}"
        state, attrs = DEFAULT_STATES[key]
        hass.states.async_set(entity_id, state, attrs)
        ids[key] = entity_id
    return ids


@pytest.fixture
def oureo(hass: HomeAssistant) -> Oureo:
    """An Oureo ESPHome charger with all 29 entities registered."""
    return Oureo(hass)


@pytest.fixture
def entry() -> MockConfigEntry:
    return MockConfigEntry(
        domain=DOMAIN, title="EO-Lite", data={CONF_CHARGER: CHARGER}, options={CONF_DASHBOARD: True}, minor_version=2
    )


@pytest.fixture
async def eo_lite(hass: HomeAssistant, oureo: Oureo, entry: MockConfigEntry) -> EoLite:
    return await set_up(hass, entry)


async def set_up(hass: HomeAssistant, entry: MockConfigEntry) -> EoLite:
    entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(entry.entry_id)
    await hass.async_block_till_done()
    return entry.runtime_data


def ws(hass: HomeAssistant, handler: Any, msg: dict[str, Any], connection: Mock | None = None) -> Mock:
    """Call a websocket command as an admin's dashboard would, checked against its schema."""
    connection = connection or Mock(user=Mock(is_admin=True), subscriptions={})
    msg = {"id": 1, **msg}
    handler(hass, connection, handler._ws_schema(msg) if handler._ws_schema else msg)
    return connection
