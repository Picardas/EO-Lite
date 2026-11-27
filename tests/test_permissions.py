"""Who may do what, checked through Home Assistant's real websocket and http
server, with real users."""

from typing import Any

import pytest
from pytest_homeassistant_custom_component.common import MockUser
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, WebSocketGenerator

from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.auth.models import Credentials
from homeassistant.components import websocket_api
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, UrlManager
from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import DOMAIN
from custom_components.eo_lite.engine import EoLite

from .conftest import CHARGER


@pytest.fixture(autouse=True)
async def no_frontend(hass: HomeAssistant) -> None:
    """Home Assistant's real http server, so commands go through its
    websocket as a browser's do."""
    assert await async_setup_component(hass, "http", {})
    hass.config.components.add("frontend")
    hass.data[DATA_EXTRA_MODULE_URL] = UrlManager(lambda *_: None, [])


async def _token(hass: HomeAssistant, user: MockUser) -> str:
    credential = Credentials(
        id=f"credential-{user.id}",
        auth_provider_type="homeassistant",
        auth_provider_id=None,
        data={"username": user.id},
        is_new=False,
    )
    user.credentials.append(credential)
    refresh = await hass.auth.async_create_refresh_token(user, "https://example.com/app", credential=credential)
    return hass.auth.async_create_access_token(refresh)


@pytest.fixture
async def ordinary_user(hass: HomeAssistant, local_auth: Any) -> MockUser:
    return MockUser(groups=[await hass.auth.async_get_group(GROUP_ID_USER)]).add_to_hass(hass)


@pytest.fixture
async def dashboards(
    hass: HomeAssistant,
    eo_lite: EoLite,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    ordinary_user: MockUser,
    hass_read_only_user: MockUser,
) -> dict[str, Any]:
    users = {"admin": hass_admin_user, "user": ordinary_user, "reader": hass_read_only_user}
    return {who: await hass_ws_client(hass, await _token(hass, user)) for who, user in users.items()}


async def send(client: Any, **msg: Any) -> dict[str, Any]:
    await client.send_json_auto_id(msg)
    return await client.receive_json()


def error(answer: dict[str, Any]) -> str | None:
    return None if answer["success"] else answer["error"]["code"]


async def test_anyone_s_dashboard_is_told_the_setup_and_changes_nothing(
    eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    before = eo_lite.dashboard_added
    for who in ("admin", "user", "reader"):
        answer = await send(dashboards[who], type=f"{DOMAIN}/config")
        assert answer["result"]["entities"]["charge_mode"] == f"select.{CHARGER}_charge_mode"
    assert error(await send(dashboards["reader"], type=f"{DOMAIN}/subscribe")) is None
    event = await dashboards["reader"].receive_json()
    assert event["event"]["entities"]["charge_mode"] == f"select.{CHARGER}_charge_mode"
    assert eo_lite.dashboard_added == before


async def test_only_admins_add_the_dashboard(eo_lite: EoLite, dashboards: dict[str, Any]) -> None:
    claim = {"type": f"{DOMAIN}/claim_dashboard"}
    for who in ("user", "reader"):
        for extra in ({}, {"release": True}, {"release": True, "error": "x"}):
            assert error(await send(dashboards[who], **claim, **extra)) == websocket_api.ERR_UNAUTHORIZED
    assert eo_lite.dashboard_added is False
    assert (await send(dashboards["admin"], **claim))["result"] == {"claimed": True}
    assert (await send(dashboards["admin"], **claim, release=True))["result"] == {"claimed": False}
    assert eo_lite.dashboard_added is False


@pytest.mark.parametrize(
    "bad",
    [
        {"release": "yes"},
        {"release": 1},
        {"release": None},
        {"error": "x" * 301},
        {"error": 5},
        {"error": ["boom"]},
        {"error": {"boom": 1}},
        {"unexpected": 1},
    ],
)
async def test_claiming_the_dashboard_takes_only_what_it_should(
    eo_lite: EoLite, dashboards: dict[str, Any], bad: dict[str, Any]
) -> None:
    answer = await send(dashboards["admin"], type=f"{DOMAIN}/claim_dashboard", **bad)
    assert error(answer) == websocket_api.ERR_INVALID_FORMAT
    assert eo_lite.dashboard_added is False


@pytest.mark.parametrize("command", ["config", "subscribe"])
@pytest.mark.parametrize("extra", [{"release": True}, {"entity_id": "x" * 10000}, {"charger": "../../"}])
async def test_the_dashboard_s_other_commands_take_nothing(
    dashboards: dict[str, Any], command: str, extra: dict[str, Any]
) -> None:
    assert (
        error(await send(dashboards["reader"], type=f"{DOMAIN}/{command}", **extra)) == websocket_api.ERR_INVALID_FORMAT
    )


async def test_the_dashboard_s_error_stays_on_one_log_line(
    dashboards: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    forged = "boom\n2026-11-20 03:00:00.000 ERROR (MainThread) [homeassistant.components.http.ban] forged\x1b[31m"
    claim = {"type": f"{DOMAIN}/claim_dashboard", "release": True, "error": forged}
    assert error(await send(dashboards["admin"], **claim)) is None
    logged = next(record.getMessage() for record in caplog.records if "Charger dashboard" in record.getMessage())
    assert logged.endswith(
        "boom 2026-11-20 03:00:00.000 ERROR (MainThread) [homeassistant.components.http.ban] forged [31m"
    )


async def test_the_scripts_are_served_and_nothing_else(
    eo_lite: EoLite, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    for url in (dashboard.URL, dashboard.LOADER_URL):
        response = await client.get(url)
        assert response.status == 200
        assert "javascript" in response.headers["Content-Type"]
        assert response.headers["Cache-Control"].startswith("public, max-age=")
    for url in (
        f"/{DOMAIN}/manifest.json",
        f"/{DOMAIN}/eo-lite.js/../manifest.json",
        f"/{DOMAIN}/%2e%2e/manifest.json",
        f"/{DOMAIN}/..%2f..%2fmanifest.json",
        f"/{DOMAIN}/eo-lite.js%2f..%2f..%2fmanifest.json",
        f"/{DOMAIN}/frontend/eo-lite.js",
        f"/{DOMAIN}/",
        f"/{DOMAIN}/eo-lite.js/",
    ):
        response = await client.get(url)
        assert response.status in (400, 403, 404), url
        assert '"domain"' not in await response.text(), url
