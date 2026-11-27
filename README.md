# EO-Lite

[![Validate](https://github.com/Picardas/EO-Lite/actions/workflows/validate.yml/badge.svg)](https://github.com/Picardas/EO-Lite/actions/workflows/validate.yml)
[![HACS: custom](https://img.shields.io/badge/HACS-custom-41BDF5.svg)](https://hacs.xyz/docs/faq/custom_repositories/)
[![Home Assistant 2026.10+](https://img.shields.io/badge/Home%20Assistant-2026.10%2B-18BCF2.svg)](https://www.home-assistant.io/)

**A Charger dashboard for an Oureo EV charger already paired in Home Assistant
via ESPHome.**

EO-Lite keeps the look and feel of [Hue-Lite](https://github.com/Picardas/Hue-Lite)
while speaking directly to Oureo's 29 ESPHome entities:

- **Status card**: live charger state (Ready, Cable connected, Plugged in,
  Charging with live kW, Mains fault, or Offline), an NTP clock-sync warning
  banner when `Timer` mode is waiting on time sync, a 3-way **Charge mode**
  control (`Off`, `Timer`, `On`), and a 24-hour timer strip when `Timer` mode
  is active.
- **Timer 1 & Timer 2**: collapsible blocks for Oureo's two on-device timer
  windows (`enabled`, `start`, `end`).
- **Power**: live power graph, session energy, persistent lifetime energy
  (`energy_total`), and live current, voltage, and frequency.
- **Diagnostics** *(folded by default)*: hardware/Pi diagnostics, binary state
  sensors, mains voltage calibration, and the RS-485 bridge reset button.

> [!NOTE]
> EO-Lite v2 has been tested against a stand-in Oureo ESPHome charger in Home
> Assistant's test harness and in jsdom, and has not yet been tested against a
> real Home Assistant instance or live Oureo hardware.

## Installation

EO-Lite needs Home Assistant 2026.10 or later, and your Oureo charger paired
first via Home Assistant's built-in **ESPHome** integration (port `6053` and
your Noise key).

**With [HACS](https://hacs.xyz)** (recommended):
1. In HACS, open ⋮ → **Custom repositories**.
2. Add `https://github.com/Picardas/EO-Lite` as an **Integration**.
3. Download **EO-Lite**, then restart Home Assistant.

**By hand:** copy `custom_components/eo_lite` into your configuration's
`custom_components/` folder, then restart Home Assistant.

Then go to **Settings → Devices & services → Add integration → EO-Lite**.
- It asks two things: which charger, and whether to add its **Charger**
  dashboard.
- Reload the browser as an admin, and the Charger dashboard is in the sidebar
  (or add it yourself with `strategy: { type: custom:eo-lite }`).

## The Charger dashboard

One card, **Charger** (tap it to fold it all away), styled like the Hue-Lite
dashboard:

- **The status card** shows what the charger's doing (Ready, Cable connected,
  Plugged in, Charging with live kW, Mains fault, or Not answering). Tap it for
  the charger's history. Below that is the 3-way **Charge mode** selector
  (`Off`, `Timer`, `On`), directly bound to Oureo's `select.*_charge_mode`.
  When `Timer` mode is active, a strip shows the day's enabled timer windows
  with now marked, and a warning banner appears if the charger's NTP clock isn't
  synced yet.
- **Timer 1 & Timer 2**: collapsible blocks for Oureo's two on-device timer
  windows (`Enabled`, `From`, `Until`).
- **Power**: live power graph, `session_energy`, `energy_total`, and live
  current, voltage, and frequency.
- **Diagnostics**: folded by default; shows all hardware, connectivity,
  RS-485, and calibration entities plus the `reset_bridge` action.

Which blocks are folded is each person's own.

## Limitations

- **One charger.**
- **Requires Oureo paired via ESPHome.** EO-Lite finds the charger by its
  `select.*_charge_mode` entity and resolves all 29 entities by their ESPHome
  unique IDs on that device (falling back to entity names when no registry
  device is present).

## Development

```bash
pip install -r requirements_test.txt
pytest
npm ci --ignore-scripts
node tests/dashboard.test.js
pip install ruff==0.17.6 && ruff check .
```

[AGENTS.md](AGENTS.md) explains how the code is laid out and how to change it.

EO-Lite isn't affiliated with or endorsed by EO Charging or Oureo.
