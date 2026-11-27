# Oureo — Home Assistant Integration & API Reference

This document is for the Home Assistant engineer building dashboards, automations, Energy Dashboard tracking, alerts, or companion apps for **Oureo** (an EO Mini Pro 2 EV charger controller).

---

## 1. Integration Model (No Custom Component Required)

Oureo implements the **ESPHome Native API** over encrypted TCP (`port 6053`) directly in a static C daemon.

- **Use Home Assistant Core's built-in `ESPHome` integration** — no MQTT broker, no HACS, and no custom `custom_components/` integration is required.
- All 29 entities (controls, electrical sensors, binary sensors, Energy Dashboard counter, and Pi/EO diagnostics) register automatically on connect with native push updates (~1–2 s cadence; immediate ack on commands).
- If you are building an external app or service that talks to Home Assistant, interact with the standard HA entities via HA's REST/WebSocket API or AppDaemon. If you want to talk to Oureo directly in Python, use `aioesphomeapi` (see §6).

### Pairing in Home Assistant

1. Go to **Settings → Devices & Services → Add Integration → ESPHome**.
2. Enter the charger's static IP (e.g., `192.168.21.50`) and port **`6053`**.
   *(On the same subnet, Oureo also advertises `_esphomelib._tcp` via Avahi mDNS. Across VLANs with mDNS reflection off, pair by static IP.)*
3. Paste the **32-byte Base64 Noise encryption key** generated during installation (`/etc/oureo/noise.key`).

### Transport & Device Identity

| Property | Value |
|---|---|
| Protocol | ESPHome Native API v1.10 (`Protobuf` over Noise) |
| Port | TCP `6053` (Home Assistant initiates outbound to charger) |
| Encryption | Mandatory `Noise_NNpsk0_25519_ChaChaPoly_SHA256` (plaintext rejected) |
| `name` | `oureo` |
| `friendly_name` | `EO Mini Pro 2` |
| `model` | `EO Mini Pro 2` |
| `manufacturer` | `EO Charging (Oureo)` |
| `project_name` / `version` | `oureo.evse` / `0.1.0` |
| Concurrent clients | Up to 4 simultaneous encrypted sessions |
| Idle timeout | 90 s (HA's built-in `PingRequest` keeps sessions alive) |

> **Entity ID naming note:** Home Assistant generates entity IDs from the device `friendly_name` (or renamed device name) + `object_id` — e.g. `select.eo_mini_pro_2_charge_mode`, `sensor.eo_mini_pro_2_power`, `binary_sensor.eo_mini_pro_2_charging_active`.

---

## 2. Complete Entity Reference (29 Entities)

### 2.1 Controls

| HA Domain | `object_id` | API Key | Category | Values / Range | Behavior |
|---|---|---|---|---|---|
| `select` | `charge_mode` | `0x1001` | Primary | `"Off"`, `"On"`, `"Timer"` | **Master control.** `Off` always stops charging immediately; `On` charges at 32 A (capped by PCB rotary switch); `Timer` charges only inside enabled timer windows when NTP clock is synced. |
| `switch` | `timer_1_enabled` | `0x1010` | Config | `true` / `false` | Enables or disables on-device Timer Window 1. |
| `time` | `timer_1_start` | `0x1011` | Config | `HH:MM:00` | Start time (local Pi timezone) for Timer 1 (default `00:30`). Seconds are ignored (`00`). |
| `time` | `timer_1_end` | `0x1012` | Config | `HH:MM:00` | End time for Timer 1 (default `04:30`). Supports midnight wraparound (e.g. `23:30` → `05:30`). |
| `switch` | `timer_2_enabled` | `0x1020` | Config | `true` / `false` | Enables or disables on-device Timer Window 2. |
| `time` | `timer_2_start` | `0x1021` | Config | `HH:MM:00` | Start time for Timer 2 (default `00:00`). |
| `time` | `timer_2_end` | `0x1022` | Config | `HH:MM:00` | End time for Timer 2 (default `00:00`). |
| `number` | `mains_voltage_correction` | `0x1030` | Config | `50.0`–`150.0` `%` (step `0.1`, default `77.8`) | Calibration multiplier for MCU raw peak-to-peak ADC voltage (`V_rms = raw / (2√2) * pct / 100`). Affects reported `voltage`, `power`, and `kWh`; does **not** alter charging current. |
| `button` | `reset_bridge` | `0x1040` | Diagnostic | Press (`restart`) | Pulses BCM GPIO 16 to hard-reset the SC16IS7xx SPI-to-RS485 bridge on demand. |

### 2.2 Electrical & Energy Sensors

| HA Domain | `object_id` | API Key | Unit | Decimals | `device_class` | `state_class` | Notes |
|---|---|---|---|---:|---|---|---|
| `sensor` (text) | `charger_state` | `0x2001` | — | — | — | — | EO MCU state name (see §2.5). Unavailable if RS-485 drops. |
| `sensor` | `current` | `0x2002` | `A` | 1 | `current` | `measurement` | Live vehicle phase-1 current (`p1_current` from MCU). |
| `sensor` | `voltage` | `0x2003` | `V` | 1 | `voltage` | `measurement` | Calibrated RMS mains voltage. |
| `sensor` | `power` | `0x2004` | `W` | 0 | `power` | `measurement` | Live apparent power (`voltage × current`). |
| `sensor` | `frequency` | `0x2005` | `Hz` | 0 | `frequency` | `measurement` | Mains frequency reported by EO MCU (typically `50 Hz`). |
| `sensor` | `session_energy` | `0x2006` | `kWh` | 3 | `energy` | `total` | Current plug-in session energy; resets to `0` when a vehicle newly connects. |
| `sensor` | `energy_total` | `0x2007` | `kWh` | 3 | `energy` | `total_increasing` | **Persistent monotonic lifetime counter** (survives reboots & Wi-Fi drops). Add directly to HA's Energy Dashboard. |

### 2.3 Binary Sensors

| HA Domain | `object_id` | API Key | `device_class` | Category | True When |
|---|---|---|---|---|---|
| `binary_sensor` | `cable_connected` | `0x3001` | `plug` | Primary | EO state in `7..16` or `18` (`charge-paused`). |
| `binary_sensor` | `vehicle_connected` | `0x3002` | `connectivity` | Primary | EO state in `9..16` or `18` (`charge-paused`). |
| `binary_sensor` | `charging_active` | `0x3003` | `battery_charging` | Primary | EO state in `11, 12` (`charging-start`, `charging`) **only** (`charge-complete` is `false`). |
| `binary_sensor` | `mains_fault` | `0x3004` | `problem` | Primary | EO state in `3, 4` (`mains-fault-start`, `mains-fault`). |
| `binary_sensor` | `controller_connected` | `0x3005` | `connectivity` | Diagnostic | RS-485 link to EO power board is healthy (`false` after ≥2 consecutive poll failures). |
| `binary_sensor` | `clock_synced` | `0x3006` | `connectivity` | Diagnostic | Linux kernel NTP sync active (`adjtimex` `STA_UNSYNC == 0`). Must be `true` for `Timer` mode to energize. |

### 2.4 Diagnostic Sensors (`entity_category: diagnostic`)

| HA Domain | `object_id` | API Key | Unit | `device_class` | `state_class` | Meaning |
|---|---|---|---|---|---|---|
| `sensor` | `cpu_temperature` | `0x4001` | `°C` | `temperature` | `measurement` | Pi Zero W SoC temp (`/sys/class/thermal/thermal_zone0/temp`). Alert if `> 75 °C` inside the outdoor black enclosure. |
| `sensor` | `wifi_rssi` | `0x4002` | `dBm` | `signal_strength` | `measurement` | Wi-Fi signal strength (`/proc/net/wireless`). |
| `sensor` | `rs485_errors` | `0x4003` | — | — | `total_increasing` | Cumulative RS-485 retries, checksum mismatches, and UART LSR errors since boot. |
| `sensor` (text) | `eo_firmware_version` | `0x4004` | — | — | — | EO MCU firmware hex string (e.g. `0x14`). |
| `sensor` | `hw_max_current` | `0x4005` | `A` | `current` | — | Active hardware-applied pilot duty limit (`hub_duty_limit × 0.06` A — `0.0 A` when Off, up to `32.0 A` or PCB rotary switch cap when On). |
| `sensor` | `watchdog_timeout` | `0x4006` | — | — | — | Raw EO MCU `watchdog_time` register value. |
| `sensor` | `watchdog_current` | `0x4007` | — | — | — | Raw EO MCU `watchdog_current` fallback register value. |

### 2.5 `charger_state` Enumerated Values

| Code | String Value | Meaning |
|---:|---|---|
| `0` | `start` | MCU boot |
| `1` | `settle-time` | Startup settle |
| `2` | `test-incoming-mains` | Mains self-test |
| `3` / `4` | `mains-fault-start` / `mains-fault` | Incoming mains fault (`mains_fault = true`, charging halted) |
| `5` / `6` | `idle-start` / `idle` | No cable/car connected |
| `7` / `8` | `plug-present-start` / `plug-present` | Cable detected, no vehicle |
| `9` / `10` | `car-connected-start` / `car-connected` | Vehicle connected, waiting for pilot enable or car demand |
| `11` / `12` | `charging-start` / `charging` | Contactor closed, actively delivering power |
| `13` / `14` | `charge-complete-start` / `charge-complete` | Vehicle finished charging |
| `15` / `16` | `charge-suspended-start` / `charge-suspended` | Charging suspended by EVSE or vehicle |
| `17` | `unknown` | Unmapped EO state |
| `18` | `charge-paused` | Charging paused (cable & vehicle remain connected) |

---

## 3. Control Semantics & Safety Invariants (Important for App/Automation Logic)

1. **Unambiguous 3-Way Mode (`select.*_charge_mode`)**:
   - `Off`: Always commands `0 A` (`0x000`) immediately — **overrides all timers and bypasses contactor dwell**.
   - `On`: Commands `32 A` (`0x215`, automatically capped by the EO board's physical rotary switch) immediately.
   - `Timer`: Evaluates `timer_1` and `timer_2` locally on the Pi (logical OR of enabled windows). A window with `start == end` is inactive; `start > end` wraps cleanly across midnight (`minute >= start || minute < end`).
2. **Offline / Wi-Fi Drop Resilience**:
   - If Home Assistant restarts or Wi-Fi drops, Oureo continues executing the active mode (`Off`, `On`, or `Timer`) locally and keeps feeding the EO MCU watchdog every 2 seconds.
   - Energy (`session_energy` and `energy_total`) keeps integrating locally while offline and catches up automatically when HA reconnects.
3. **Power-Loss Safety Downgrade**:
   - All settings (`charge_mode`, timers, `mains_voltage_correction`, `energy_total`) are persisted atomically to `/var/lib/oureo/state`.
   - On reboot / power cut: persisted `On` is **automatically downgraded to `Off`** so an unattended charger never unexpectedly energizes at 7.4 kW when mains returns. Persisted `Timer` and `Off` are restored as saved.
4. **NTP Sync Gate for `Timer` Mode**:
   - Because the Pi Zero W has no RTC battery, `Timer` mode **will not start charging after boot until `binary_sensor.*_clock_synced` is `on`**. Display a warning banner in your HA UI if `charge_mode == "Timer"` and `clock_synced == off`.
5. **Contactor Dwell Protection**:
   - Automatic `Timer` transitions enforce a 15-second minimum dwell between On/Off flips to protect the AC contactor. Manual `Off` and `mains_fault` bypass dwell immediately.
6. **Unavailable State Handling**:
   - If the RS-485 link to the EO power board drops (`controller_connected = off`), all hardware-sourced sensors (`charger_state`, `current`, `voltage`, `power`, `frequency`, `cable_connected`, `vehicle_connected`, `charging_active`, `mains_fault`) report `missing_state = true` → Home Assistant displays **`Unavailable`** rather than stale readings.

---

## 4. Home Assistant Setup & Automation Patterns

### 4.1 Energy Dashboard
Add `sensor.eo_mini_pro_2_energy_total` directly under **Settings → Dashboards → Energy → Individual Devices** (no Utility Meter or Riemann Sum helper needed; HA tracks daily/monthly/tariff costs automatically).

### 4.2 Recommended Lovelace Dashboard Card
```yaml
type: vertical-stack
cards:
  - type: entities
    title: EV Charger (Oureo)
    entities:
      - entity: select.eo_mini_pro_2_charge_mode
      - entity: sensor.eo_mini_pro_2_charger_state
      - entity: binary_sensor.eo_mini_pro_2_vehicle_connected
      - entity: binary_sensor.eo_mini_pro_2_charging_active
      - entity: sensor.eo_mini_pro_2_power
      - entity: sensor.eo_mini_pro_2_current
      - entity: sensor.eo_mini_pro_2_voltage
      - entity: sensor.eo_mini_pro_2_session_energy
      - entity: sensor.eo_mini_pro_2_energy_total

  - type: conditional
    conditions:
      - condition: state
        entity: select.eo_mini_pro_2_charge_mode
        state: "Timer"
      - condition: state
        entity: binary_sensor.eo_mini_pro_2_clock_synced
        state: "off"
    card:
      type: markdown
      content: "⚠️ **Charger clock not yet NTP-synced** — Timer charging is paused until time sync completes."

  - type: entities
    title: On-Device Timers
    entities:
      - entity: switch.eo_mini_pro_2_timer_1_enabled
      - entity: time.eo_mini_pro_2_timer_1_start
      - entity: time.eo_mini_pro_2_timer_1_end
      - entity: switch.eo_mini_pro_2_timer_2_enabled
      - entity: time.eo_mini_pro_2_timer_2_start
      - entity: time.eo_mini_pro_2_timer_2_end
```

### 4.3 Recommended Safety & Health Alerts
```yaml
alias: "Oureo — Fault & Thermal Alerts"
mode: single
triggers:
  - trigger: state
    entity_id: binary_sensor.eo_mini_pro_2_mains_fault
    to: "on"
    id: mains_fault
  - trigger: state
    entity_id: binary_sensor.eo_mini_pro_2_controller_connected
    to: "off"
    for: "00:01:00"
    id: rs485_lost
  - trigger: numeric_state
    entity_id: sensor.eo_mini_pro_2_cpu_temperature
    above: 75
    for: "00:05:00"
    id: cpu_hot
actions:
  - action: notify.notify
    data:
      title: "EV Charger Alert ({{ trigger.id }})"
      message: >-
        {% if trigger.id == 'mains_fault' %}
          EO Mini Pro 2 reported a mains fault — charging halted.
        {% elif trigger.id == 'rs485_lost' %}
          Oureo lost RS-485 communication with the EO power board.
        {% else %}
          Oureo Pi CPU temperature is {{ states('sensor.eo_mini_pro_2_cpu_temperature') }} °C.
        {% endif %}
```

### 4.4 Dynamic Tariff / Smart-Charging Automation Example (e.g., Octopus Agile / Intelligent)
If Home Assistant drives dynamic slots (instead of fixed overnight windows):
- Set `select.eo_mini_pro_2_charge_mode` to `"On"` when a cheap slot opens (and `vehicle_connected` is `on`), and back to `"Off"` (or `"Timer"`) when the slot ends.
- Because `select.eo_mini_pro_2_charge_mode` responds within ~1–2 s with zero 45-second smoothing lag, switching is immediate.

---

## 5. Direct Programmatic Client Example (`aioesphomeapi`)

If you are building a standalone Python app, integration test, or daemon that talks directly to Oureo (bypassing Home Assistant), use `aioesphomeapi`:

```python
import asyncio
from aioesphomeapi import APIClient

async def main():
    client = APIClient(
        address="192.168.21.50",
        port=6053,
        password="",
        noise_psk="<BASE64_32BYTE_NOISE_PSK>",
    )
    await client.connect(login=True)

    entities, _ = await client.list_entities_services()
    by_id = {e.object_id: e for e in entities}

    def on_state(state):
        print("STATE:", state)

    client.subscribe_states(on_state)

    # Configure Timer 1 (00:30 - 04:30) and switch to Timer mode:
    client.switch_command(by_id["timer_1_enabled"].key, True)
    client.time_command(by_id["timer_1_start"].key, hour=0, minute=30, second=0)
    client.time_command(by_id["timer_1_end"].key, hour=4, minute=30, second=0)
    client.select_command(by_id["charge_mode"].key, "Timer")

    # Or force immediate charge / stop:
    # client.select_command(by_id["charge_mode"].key, "On")
    # client.select_command(by_id["charge_mode"].key, "Off")

    await asyncio.sleep(5)
    await client.disconnect()

asyncio.run(main())
```

### Local Development Without Live Charger Hardware

Your Home Assistant engineer can develop and test dashboards, automations, and apps against a live simulated charger on any Mac or Linux machine:

```bash
make
./build/oureo keygen > /tmp/oureo.key && chmod 600 /tmp/oureo.key
cat /tmp/oureo.key   # paste into HA ESPHome integration

./build/oureo daemon --mock \
  --port 6053 \
  --key /tmp/oureo.key \
  --state /tmp/oureo.state \
  --sock /tmp/oureo.sock \
  -v
```

In `--mock` mode, Oureo simulates a plugged-in EV drawing ~31.2 A (~7.3 kW at ~234.4 V) whenever charging is active, integrates real `session_energy` / `energy_total`, and accepts every Home Assistant command identically to the Pi Zero W hardware.
