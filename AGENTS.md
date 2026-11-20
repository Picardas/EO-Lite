# AGENTS.md

How to work on EO-Lite: for AI coding agents, and for anyone else. The
README covers what EO-Lite does for its users.

EO-Lite is a Home Assistant custom integration (domain `eo_lite`), installed
through HACS, built the way [Hue-Lite](https://github.com/Picardas/Hue-Lite)
is. It sits on top of an OpenEO charger's own integration: it adds two
toggles, sets the charger's switches from them, and serves a Charger
dashboard. It has no dependencies beyond Home Assistant, and its dashboard is
one plain JavaScript file with no build step.

## Layout

Paths are in `custom_components/eo_lite/`, except `tests/`, `docs/` and the
files at the repository root.

| Path | What's there |
| ---- | ------------ |
| `engine.py` | The core: the two toggles, stored data (`_stored` checks everything loaded), setting the charger's switches from them, and the Repairs issue when the charger can't be found |
| `const.py` | Names, and `charger_entities`: the charger integration's entity ids EO-Lite uses |
| `charger.py` | Finding the charger's entities and timers in the entity registry by openeo's own ids, whatever Home Assistant names them |
| `switch.py` | The toggles' entities, which check the user may control the charger's switches |
| `dashboard.py` | Serves the script; the websocket commands the dashboard uses |
| `config_flow.py`, `__init__.py` | Setup, migrations |
| `frontend/eo-lite.js` | The Charger dashboard: a strategy and its card |
| `frontend/eo-lite-loader.js` | What every page loads: it loads `eo-lite.js`, trying again if it doesn't arrive |
| `translations/en.json`, `icons.json` | Entity, setup and Repairs text; icons |
| `tests/` | pytest tests, and `dashboard.test.js` for the script. `conftest.py` has the stand-in chargers: `Charger` (switches with no unique ids, found by name) and `Openeo` (registered as openeo's MQTT discovery does, so they can be renamed, go or come back), and `ws()`, which checks a command against its schema first, as an admin |
| `tests/test_permissions.py` | Who may do what, through Home Assistant's real websocket and http server with real users |
| `docs/images/` | README screenshots |
| `pyproject.toml` | ruff's rules |
| `package.json`, `package-lock.json` | jsdom for `dashboard.test.js`, at pinned versions (test tooling only) |

The charger integration's source isn't in this repository. What's known of
it is its entity ids and how its two switches behave (see `engine.py`).

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
  script with a mock Home Assistant, for the README's screenshots in
  `docs/images/` (`?scene=timers|charging|off|full`, `&folded=power,timer_1`,
  `&phone`, `&dark`). Serve the repository root and take them with a
  headless browser, 520 px wide for a phone.
- **A real charger:** say plainly what hasn't been tried on a real charger
  or a real Home Assistant.

## Conventions

- **Keep it like Hue-Lite: simple and decoupled.** Prefer fewer settings,
  and one clear behaviour over options. The dashboard's blocks, headings and
  folding copy Hue-Lite's routines card, and the status card its light
  bars (the round icon, the colours): keep them looking alike.
- **Behaviour lives in Python.** The dashboard shows state and calls actions
  and websocket commands; it decides nothing itself.
- **Every behaviour change has a test.** Tests describe what happens from
  the user's side, one scenario per test, with comments narrating the steps.
  The stand-in charger's `charges(in_timer)` says whether the car would
  charge: assert on that rather than on which commands were sent.
- **Comments and docstrings** are plain English and say what happens, not
  how the code does it. Use British spelling (colour, behaviour).
- **Distrust stored data and the dashboard.** Check everything loaded from
  storage, and bound everything a websocket command accepts.
- **Permissions:** switching a toggle needs control of both of the charger's
  switches (an admin always may), as EO-Lite then switches them as itself.
  Commands use `_with_eo_lite`. Tests of who may do what go through the
  real websocket with real users (`hass_ws_client`), in
  `tests/test_permissions.py`.
- **The toggles are in charge.** A charger switch that comes back after
  being unavailable is set again from the toggles (only that switch: the
  other was set when it was back); a change made on the charger otherwise
  is left alone.
- **Finding the charger:** by openeo's id for it, remembered in the config
  entry (`device`) from the registry, so renamed entities and devices are
  still found. Look entities up by openeo's unique ids (`charger.py`), not
  by entity id; a charger with no unique ids is found by name.
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
