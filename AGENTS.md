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

| Path | What's there |
| ---- | ------------ |
| `custom_components/eo_lite/engine.py` | The core: the two toggles, stored data (`_stored` checks everything loaded), and setting the charger's switches from them |
| `const.py` | Names, and `charger_entities`: the charger integration's entity ids EO-Lite uses |
| `switch.py` | The toggles' entities |
| `dashboard.py` | Serves the script; the websocket commands the dashboard uses |
| `config_flow.py`, `__init__.py` | Setup |
| `frontend/eo-lite.js` | The Charger dashboard: a strategy and its card |
| `frontend/eo-lite-loader.js` | What every page loads: it loads `eo-lite.js`, trying again if it doesn't arrive |
| `translations/en.json`, `icons.json` | Entity and setup text; icons |
| `tests/` | pytest tests (`conftest.py` has the stand-in charger), and `dashboard.test.js` for the script |
| `docs/images/` | README screenshots |

The charger integration's source isn't in this repository. What's known of
it is its entity ids and how its two switches behave (see `engine.py`).

## Checking a change

```bash
pip install -r requirements_test.txt   # pins Home Assistant's test tooling, so tests run against a known version
pytest
npm install --no-save jsdom
node tests/dashboard.test.js
```

- **CI:** every push runs both, hassfest and HACS's checks (see
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
  folding copy Hue-Lite's routines card: keep them looking alike.
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
- **`manifest.json` has no requirements.** Don't add any.

## Releasing

- **Version:** bump `version` in `manifest.json` for every release.
  Browsers pick up a new script by itself: it's served versioned by its
  content.
- **Minimum Home Assistant version:** it's in `hacs.json` and the README.
  Change both together, along with the pin in `requirements_test.txt`.
- **Releases:** HACS installs GitHub releases. Push a signed tag
  (`vX.Y.Z`) and publish a release for it with notes on what changed.
