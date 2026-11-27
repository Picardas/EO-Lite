"""The Charger dashboard: serves its script (a dashboard strategy and its
card) to every page, and over the websocket tells it how EO-Lite is set up."""

from collections.abc import Callable
import functools
import hashlib
import logging
from pathlib import Path
import re
from typing import Any

import probatio as vol

from homeassistant.components import websocket_api
from homeassistant.components.frontend import add_extra_js_url, remove_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.util.hass_dict import HassKey

from .const import DOMAIN
from .engine import SIGNAL_CHARGER, EoLite, async_get_loaded

_LOGGER = logging.getLogger(__name__)

# EO-Lite's own websocket error code (Home Assistant's are in websocket_api).
ERR_NOT_LOADED = "not_loaded"

FRONTEND = Path(__file__).parent / "frontend"
SCRIPT = FRONTEND / "eo-lite.js"
URL = f"/{DOMAIN}/eo-lite.js"
# What every page loads: it loads the script, trying again if it doesn't arrive.
LOADER = FRONTEND / "eo-lite-loader.js"
LOADER_URL = f"/{DOMAIN}/eo-lite-loader.js"
DATA_URL: HassKey[str] = HassKey(f"{DOMAIN}_dashboard_url")


async def async_register(hass: HomeAssistant) -> None:
    """Serve the script and its loader (versioned by their content, so
    browsers pick up a new one) and register the websocket commands. Once per
    run."""
    content = b"".join([await hass.async_add_executor_job(path.read_bytes) for path in (LOADER, SCRIPT)])
    hass.data[DATA_URL] = f"{LOADER_URL}?v={hashlib.sha256(content).hexdigest()[:8]}"
    await hass.http.async_register_static_paths(
        [
            StaticPathConfig(URL, str(SCRIPT), cache_headers=True),
            StaticPathConfig(LOADER_URL, str(LOADER), cache_headers=True),
        ]
    )
    for command in (websocket_config, websocket_subscribe, websocket_claim_dashboard):
        websocket_api.async_register_command(hass, command)


@callback
def async_add_script(hass: HomeAssistant) -> Callable[[], None]:
    """Load the script (through its loader) on every frontend page while
    EO-Lite is set up."""
    url = hass.data[DATA_URL]
    add_extra_js_url(hass, url)
    return lambda: remove_extra_js_url(hass, url)


type Handler = Callable[[HomeAssistant, websocket_api.ActiveConnection, dict[str, Any], EoLite], None]


def _with_eo_lite(handler: Handler) -> websocket_api.WebSocketCommandHandler:
    """A command for the running EO-Lite, which it's handed; while EO-Lite
    isn't set up, the answer is an error."""

    @callback
    @functools.wraps(handler)
    def command(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
        if (eo_lite := async_get_loaded(hass)) is None:
            connection.send_error(msg["id"], ERR_NOT_LOADED, "EO-Lite isn't set up")
        else:
            handler(hass, connection, msg, eo_lite)

    return command


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/config"})
@_with_eo_lite
def websocket_config(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any], eo_lite: EoLite
) -> None:
    """What the dashboard needs: the charger prefix, its entity ids, and
    whether an admin's browser should add the Charger dashboard."""
    connection.send_result(
        msg["id"],
        {
            "charger": eo_lite.charger,
            "entities": eo_lite.charger_entities,
            "add_dashboard": eo_lite.use_dashboard and not eo_lite.dashboard_added,
        },
    )


@callback
def _charger(eo_lite: EoLite) -> dict[str, Any]:
    """The charger's current entity ids."""
    return {"entities": eo_lite.charger_entities}


@websocket_api.websocket_command({vol.Required("type"): f"{DOMAIN}/subscribe"})
@callback
def websocket_subscribe(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any]) -> None:
    """The charger's entities, now and whenever they change in the registry
    (or EO-Lite reloads). Taken even while EO-Lite isn't set up, so a
    dashboard open then hears as soon as it is, without asking again."""

    @callback
    def send(eo_lite: EoLite | None = None) -> None:
        if eo_lite := eo_lite or async_get_loaded(hass):
            connection.send_message(websocket_api.event_message(msg["id"], _charger(eo_lite)))

    connection.subscriptions[msg["id"]] = async_dispatcher_connect(hass, SIGNAL_CHARGER, send)
    connection.send_result(msg["id"])
    send()


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/claim_dashboard",
        vol.Optional("release", default=False): bool,
        vol.Optional("error"): vol.All(str, vol.Length(max=300)),
    }
)
@websocket_api.require_admin
@_with_eo_lite
def websocket_claim_dashboard(
    hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict[str, Any], eo_lite: EoLite
) -> None:
    """The Charger dashboard is added by an admin's browser, with Home
    Assistant's own dashboard commands. The first to claim it adds it (or
    finds one already there); `release` gives the claim back if that failed,
    with the `error`, which goes in the log."""
    if error := msg.get("error"):
        # Control characters become spaces, so the browser's text stays on one log line.
        _LOGGER.warning(
            "Couldn't add the Charger dashboard (it'll be tried again): %s", re.sub(r"[\x00-\x1f\x7f]", " ", error)
        )
    connection.send_result(msg["id"], {"claimed": eo_lite.claim_dashboard(msg["release"])})
