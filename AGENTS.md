# AGENTS.md

How to work on EO-Lite: for AI coding agents, and for anyone else. The
README covers what EO-Lite does for its users.

EO-Lite is a Home Assistant custom integration (domain `eo_lite`), installed
through HACS, built the way [Hue-Lite](https://github.com/Picardas/Hue-Lite)
is. It sits on top of Home Assistant Core's built-in `ESPHome` integration for
an **Oureo** EV charger (documented in `HOMEASSISTANT_API.md`) and serves a
Charger dashboard. It has no dependencies beyond Home Assistant, creates no
synthetic proxy switch entities, and its dashboard is one plain JavaScript file
with no build step.

## Layout

Paths are in `custom_components/eo_lite/`, except `tests/`, `docs/` and the
files at the repository root.

| Path | What's there |
| ---- | ------------ |
| `engine.py` | The core: remembering the charger device, watching the entity registry for renames, stored data (`_stored` checks everything loaded) |
| `const.py` | Names, and `OUREO_ENTITIES` / `charger_entities`: all 29 Oureo entities from `HOMEASSISTANT_API.md` |
| `charger.py` | Finding the charger's 29 entities in the entity registry by ESPHome component + `object_id`, whatever Home Assistant names them |
| `dashboard.py` | Serves the script; the websocket commands the dashboard uses |
| `config_flow.py`, `__init__.py` | Setup and entry lifecycle |
| `frontend/eo-lite.js` | The Charger dashboard: a strategy and its card |
| `frontend/eo-lite-loader.js` | What every page loads: it loads `eo-lite.js`, trying again if it doesn't arrive |
| `translations/en.json` | Setup text |
| `tests/` | pytest tests, and `dashboard.test.js` for the script. `conftest.py` has the `Oureo` stand-in (registered via ESPHome in the entity and device registries so entities can be renamed), `add_simple_charger` (plain states without registry entries), and `ws()`, which checks a command against its schema first, as an admin |
| `tests/test_charger.py` | Mapping all 29 Oureo entities, rename tracking, and ignoring unrelated registry events |
| `tests/test_permissions.py` | Who may do what, through Home Assistant's real websocket and http server with real users |
| `docs/images/` | README screenshots |
| `pyproject.toml` | ruff's rules |
| `package.json`, `package-lock.json` | jsdom for `dashboard.test.js`, at pinned versions (test tooling only) |

## Checking a change

```bash
pip install -r requirements_test.txt   # pins Home Assistant's test tooling, so tests run against a known version
pytest
npm ci --ignore-scripts                # jsdom, at the versions in package-lock.json
node tests/dashboard.test.js
pip install ruff==0.17.6 && ruff check .   # the version CI uses; rules in pyproject.toml
```

- **CI:** every push runs both test suites, ruff, hassfest and HACS's
  checks, and checks the dashboard scripts parse (see
  `.github/workflows/validate.yml`).
- **Screenshots:** `tests/screenshots/index.html` renders the dashboard
  script with a mock Home Assistant (`?scene=timers|charging|off|fault|ntp`,
  `&folded=power,timer_1,diagnostics`, `&phone`, `&dark`).
- **A real charger:** say plainly what hasn't been tried on a real charger
  or a real Home Assistant.

## Conventions

- **Keep it like Hue-Lite: simple and decoupled.** Prefer fewer settings,
  and one clear behaviour over options. The dashboard's blocks, headings and
  folding copy Hue-Lite's routines card, and the status card its light
  bars (the round icon, the colours): keep them looking alike.
- **Behaviour lives in Python / Oureo.** The dashboard shows state and calls
  Home Assistant actions and websocket commands; it decides nothing itself.
- **Every behaviour change has a test.** Tests describe what happens from
  the user's side, one scenario per test, with comments narrating the steps.
- **Comments and docstrings** are plain English and say what happens, not
  how the code does it. Use British spelling (colour, behaviour).
- **Distrust stored data and the dashboard.** Check everything loaded from
  storage, and bound everything a websocket command accepts.
- **Finding the charger:** by Home Assistant's device id for the ESPHome
  charger, remembered in the config entry (`device`) from `select.*_charge_mode`.
  Look entities up in `charger.py` by ESPHome `-{component}-{object_id}`
  unique IDs so renamed entities are still found without substring collisions
  (`current` vs `hw_max_current` / `watchdog_current`). Fall back to default
  names when no registry entry is present.
- **Python:** `import probatio as vol` (Home Assistant's validation library;
  `voluptuous` is only an alias of it). No `from __future__` imports: Home
  Assistant needs Python 3.14, which doesn't need them.
- **Migrations:** a config entry's go in `async_migrate_entry`, with
  `MINOR_VERSION` raised. Never raise `STORAGE_VERSION`: an older EO-Lite
  couldn't load the data then. New stored data is optional and checked in
  `_stored` instead.
- **`manifest.json` has no requirements.** Don't add any.

## Releasing

- **Version:** bump `version` in `manifest.json` for every release.
  Browsers pick up a new script by itself: it's served versioned by its
  content.
- **Minimum Home Assistant version:** it's in `hacs.json` and the README.
  Change both together, along with the pin in `requirements_test.txt`.
- **Commits:** sign them, and never skip hooks or signing.
- **Releases:** HACS installs GitHub releases. Push a signed tag
  (`vX.Y.Z`) and publish a release for it with notes on what changed.
