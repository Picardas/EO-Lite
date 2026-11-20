"""Who may do what, checked through Home Assistant's real websocket and http
server, with real users: an admin, an ordinary user, a read-only one, and
one allowed EO-Lite's toggles but not the charger's own switches."""

from typing import Any

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry, MockUser
from pytest_homeassistant_custom_component.typing import ClientSessionGenerator, WebSocketGenerator

from homeassistant.auth.const import GROUP_ID_USER
from homeassistant.auth.models import Credentials
from homeassistant.components import websocket_api
from homeassistant.components.frontend import DATA_EXTRA_MODULE_URL, UrlManager
from homeassistant.core import Context, HomeAssistant
from homeassistant.exceptions import Unauthorized
from homeassistant.setup import async_setup_component

from custom_components.eo_lite import dashboard
from custom_components.eo_lite.const import DOMAIN
from custom_components.eo_lite.engine import EoLite

from .conftest import ALLOW, CHARGING, ONLY_TIMERS, TIMERS, Charger, add_openeo, set_up


@pytest.fixture(autouse=True)
async def no_frontend(hass: HomeAssistant) -> None:
    """Home Assistant's real http server, so commands go through its
    websocket (and their schemas and permission checks) as a browser's do;
    the frontend is still stood in for."""
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


async def _user(hass: HomeAssistant) -> MockUser:
    return MockUser(groups=[await hass.auth.async_get_group(GROUP_ID_USER)]).add_to_hass(hass)


@pytest.fixture
async def ordinary_user(hass: HomeAssistant, local_auth: Any) -> MockUser:
    """A user who isn't an admin, and may control everything."""
    return await _user(hass)


@pytest.fixture
async def limited_user(hass: HomeAssistant, local_auth: Any) -> MockUser:
    """A user allowed EO-Lite's toggles, who may only look at the charger's
    own switches."""
    user = await _user(hass)
    user.mock_policy(
        {"entities": {"entity_ids": {ALLOW: True, ONLY_TIMERS: True, CHARGING: {"read": True}, TIMERS: {"read": True}}}}
    )
    return user


@pytest.fixture
async def dashboards(
    hass: HomeAssistant,
    eo_lite: EoLite,
    hass_ws_client: WebSocketGenerator,
    hass_admin_user: MockUser,
    ordinary_user: MockUser,
    hass_read_only_user: MockUser,
    limited_user: MockUser,
) -> dict[str, Any]:
    """With EO-Lite set up, an open dashboard for each user."""
    users = {"admin": hass_admin_user, "user": ordinary_user, "reader": hass_read_only_user, "limited": limited_user}
    return {who: await hass_ws_client(hass, await _token(hass, user)) for who, user in users.items()}


async def send(dashboard: Any, **msg: Any) -> dict[str, Any]:
    """Send a command and wait for its answer."""
    await dashboard.send_json_auto_id(msg)
    return await dashboard.receive_json()


def error(answer: dict[str, Any]) -> str | None:
    return None if answer["success"] else answer["error"]["code"]


def refused(answer: dict[str, Any]) -> bool:
    """An action refused for want of permission (which call_service answers
    as a Home Assistant error saying so)."""
    return not answer["success"] and answer["error"]["message"] == "Unauthorized"


def flip(entity_id: str, on: bool) -> dict[str, Any]:
    """Switching a switch, as the dashboard does."""
    return {
        "type": "call_service",
        "domain": "switch",
        "service": "turn_on" if on else "turn_off",
        "target": {"entity_id": entity_id},
    }


async def settle(hass: HomeAssistant) -> None:
    await hass.async_block_till_done(wait_background_tasks=True)


# ---- Read-only users ---------------------------------------------------------


async def test_a_read_only_user_cant_switch_the_toggles(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    # Someone who may only look tries both toggles: both are refused.
    for entity_id in (ALLOW, ONLY_TIMERS):
        assert refused(await send(dashboards["reader"], **flip(entity_id, True)))
    await settle(hass)
    assert eo_lite.settings == {"allow_charging": False, "only_during_timers": False}
    assert not charger.charges(in_timer=True)
    # Anyone who may control the charger can, as before.
    assert error(await send(dashboards["user"], **flip(ALLOW, True))) is None
    await settle(hass)
    assert charger.charges(in_timer=False)


async def test_anyone_s_dashboard_is_told_the_set_up_and_changes_nothing(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    """The set-up is entity ids anyone can see already."""
    before = (dict(eo_lite.settings), eo_lite.dashboard_added)
    for who in ("admin", "user", "reader"):
        answer = await send(dashboards[who], type=f"{DOMAIN}/config")
        assert answer["result"]["entities"]["allow_charging"] == ALLOW
    # A subscription gets the charger now.
    assert error(await send(dashboards["reader"], type=f"{DOMAIN}/subscribe")) is None
    event = await dashboards["reader"].receive_json()
    assert event["event"]["entities"]["charging_switch"] == CHARGING
    assert (dict(eo_lite.settings), eo_lite.dashboard_added) == before


# ---- The charger's own switches ----------------------------------------------


async def test_the_toggles_need_the_charger_s_switches_allowed_too(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    """Switching a toggle switches the charger, so it takes permission to
    control the charger."""
    # The limited user can't switch the charger itself...
    assert refused(await send(dashboards["limited"], **flip(CHARGING, True)))
    # ...nor charge the car through Allow charging.
    assert refused(await send(dashboards["limited"], **flip(ALLOW, True)))
    await settle(hass)
    assert not charger.charges(in_timer=True)
    assert hass.states.get(ALLOW).state == "off"


async def test_only_during_timers_needs_them_allowed_too(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    # The admin allows charging, only during timers.
    assert error(await send(dashboards["admin"], **flip(ONLY_TIMERS, True))) is None
    assert error(await send(dashboards["admin"], **flip(ALLOW, True))) is None
    await settle(hass)
    # The limited user can't make it charge now by switching Only during timers off.
    assert refused(await send(dashboards["limited"], **flip(ONLY_TIMERS, False)))
    await settle(hass)
    assert not charger.charges(in_timer=False)
    assert charger.charges(in_timer=True)


async def test_a_switch_group_asks_the_same(hass: HomeAssistant, charger: Charger, limited_user: MockUser) -> None:
    """The bar Home Assistant sets: its own switch group of the charger's
    switches refuses a user who may not control them."""
    group = MockConfigEntry(
        domain="group",
        title="both",
        options={
            "group_type": "switch",
            "name": "both",
            "entities": [CHARGING, TIMERS],
            "hide_members": False,
            "all": False,
        },
    )
    group.add_to_hass(hass)
    assert await hass.config_entries.async_setup(group.entry_id)
    await hass.async_block_till_done()
    limited_user.mock_policy({"entities": {"entity_ids": {"switch.both": True}}})
    with pytest.raises(Unauthorized):
        await hass.services.async_call(
            "switch", "turn_on", {"entity_id": "switch.both"}, blocking=True, context=Context(user_id=limited_user.id)
        )
    await settle(hass)
    assert not charger.charges(in_timer=False)


async def test_a_renamed_charger_switch_needs_allowing_by_its_new_id(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client: WebSocketGenerator, local_auth: Any
) -> None:
    openeo = await add_openeo(hass)
    await set_up(hass, entry)
    user = await _user(hass)
    client = await hass_ws_client(hass, await _token(hass, user))
    # The timers switch is renamed in Settings.
    await openeo.rename("timers_switch", "switch.garage_timers")
    # A user allowed the charger's switches by their old ids is refused.
    user.mock_policy({"entities": {"entity_ids": {ALLOW: True, ONLY_TIMERS: True, CHARGING: True, TIMERS: True}}})
    assert refused(await send(client, **flip(ALLOW, True)))
    await settle(hass)
    assert not openeo.charges(in_timer=True)
    # Allowed the new one, they can switch.
    user.mock_policy(
        {"entities": {"entity_ids": {ALLOW: True, ONLY_TIMERS: True, CHARGING: True, "switch.garage_timers": True}}}
    )
    assert error(await send(client, **flip(ALLOW, True))) is None
    await settle(hass)
    assert openeo.charges(in_timer=False)


async def test_the_logbook_says_who_switched_the_charger(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any], ordinary_user: MockUser
) -> None:
    """The charger's switch changes as caused by the toggle, so the logbook
    says who started the car charging."""
    answer = await send(dashboards["user"], **flip(ALLOW, True))
    await settle(hass)
    assert charger.charges(in_timer=False)
    assert hass.states.get(ALLOW).context.user_id == ordinary_user.id
    assert hass.states.get(CHARGING).context.parent_id == answer["result"]["context"]["id"]


# ---- Adding the dashboard ------------------------------------------------------


async def test_only_admins_add_the_dashboard(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any]
) -> None:
    claim = {"type": f"{DOMAIN}/claim_dashboard"}
    # Nobody else can claim it, or give it back.
    for who in ("user", "reader", "limited"):
        for extra in ({}, {"release": True}, {"release": True, "error": "x"}):
            assert error(await send(dashboards[who], **claim, **extra)) == websocket_api.ERR_UNAUTHORIZED
    assert eo_lite.dashboard_added is False
    # An admin's browser claims it, sent as the dashboard sends it, and can give it back.
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
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any], bad: dict[str, Any]
) -> None:
    answer = await send(dashboards["admin"], type=f"{DOMAIN}/claim_dashboard", **bad)
    assert error(answer) == websocket_api.ERR_INVALID_FORMAT
    assert eo_lite.dashboard_added is False


@pytest.mark.parametrize("command", ["config", "subscribe"])
@pytest.mark.parametrize("extra", [{"release": True}, {"entity_id": "x" * 10000}, {"charger": "../../"}])
async def test_the_dashboard_s_other_commands_take_nothing(
    hass: HomeAssistant,
    charger: Charger,
    eo_lite: EoLite,
    dashboards: dict[str, Any],
    command: str,
    extra: dict[str, Any],
) -> None:
    assert (
        error(await send(dashboards["reader"], type=f"{DOMAIN}/{command}", **extra)) == websocket_api.ERR_INVALID_FORMAT
    )


async def test_the_dashboard_s_error_stays_on_one_log_line(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, dashboards: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    """When an admin's browser couldn't add the Charger dashboard, its error
    goes in the log as one line, whatever it says."""
    forged = "boom\n2026-11-20 03:00:00.000 ERROR (MainThread) [homeassistant.components.http.ban] forged\x1b[31m"
    claim = {"type": f"{DOMAIN}/claim_dashboard", "release": True, "error": forged}
    assert error(await send(dashboards["admin"], **claim)) is None
    logged = next(record.getMessage() for record in caplog.records if "Charger dashboard" in record.getMessage())
    assert logged.endswith(
        "boom 2026-11-20 03:00:00.000 ERROR (MainThread) [homeassistant.components.http.ban] forged [31m"
    )


# ---- The script ----------------------------------------------------------------


async def test_the_scripts_are_served_and_nothing_else(
    hass: HomeAssistant, charger: Charger, eo_lite: EoLite, hass_client_no_auth: ClientSessionGenerator
) -> None:
    client = await hass_client_no_auth()
    # The script and its loader, kept by browsers (pages ask for them by
    # their content's hash).
    for url in (dashboard.URL, dashboard.LOADER_URL):
        response = await client.get(url)
        assert response.status == 200
        assert "javascript" in response.headers["Content-Type"]
        assert response.headers["Cache-Control"].startswith("public, max-age=")
    # Nothing else of EO-Lite's, however it's asked for.
    for url in (
        "/eo_lite/manifest.json",
        "/eo_lite/eo-lite.js/../manifest.json",
        "/eo_lite/%2e%2e/manifest.json",
        "/eo_lite/..%2f..%2fmanifest.json",
        "/eo_lite/eo-lite.js%2f..%2f..%2fmanifest.json",
        "/eo_lite/frontend/eo-lite.js",
        "/eo_lite/",
        "/eo_lite/eo-lite.js/",
    ):
        response = await client.get(url)
        assert response.status in (400, 403, 404), url
        assert '"domain"' not in await response.text(), url
