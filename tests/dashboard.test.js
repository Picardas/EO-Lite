// The dashboard script in a stand-in browser (jsdom), with stand-ins for
// Home Assistant's cards, storage and websocket.
//   npm ci --ignore-scripts && node tests/dashboard.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "custom_components", "eo_lite", "frontend", "eo-lite.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));
// Values made in the page, as plain ones to compare.
const plain = (value) => JSON.parse(JSON.stringify(value));

const C = "openeo_charger";
// What EO-Lite tells the dashboard.
const SETUP = {
  charger: C,
  add_dashboard: false,
  entities: {
    charging_switch: `switch.${C}_charging`,
    timers_switch: `switch.${C}_timers`,
    state: `sensor.${C}_charger_state`,
    power: `sensor.${C}_power_delivered`,
    vehicle_current: `sensor.${C}_vehicle_current`,
    charging_active: `binary_sensor.${C}_charging_active`,
    vehicle_connected: `binary_sensor.${C}_vehicle_connected`,
    session_kwh: `sensor.${C}_session_kwh`,
    session_cost: `sensor.${C}_session_cost`,
    add_timer: `button.${C}_add_charge_schedule`,
    allow_charging: "switch.front_garden_eo_lite_allow_charging",
    only_during_timers: "switch.front_garden_eo_lite_only_during_timers",
  },
};
const E = SETUP.entities;

// A house whose charger has these timers ([start, end, amps] each, from
// timer 1), and `extra` any other states.
function states(timers, extra = {}) {
  const s = {
    "light.kitchen": { state: "on", attributes: {} },
    [E.allow_charging]: { state: "off", attributes: {} },
    [E.only_during_timers]: { state: "off", attributes: {} },
    [E.state]: { state: "idle", attributes: {} },
    [E.charging_active]: { state: "off", attributes: {} },
    [E.vehicle_connected]: { state: "off", attributes: {} },
    [E.power]: { state: "0", attributes: { unit_of_measurement: "kW" } },
    [E.vehicle_current]: { state: "0", attributes: {} },
    [E.session_kwh]: { state: "0", attributes: {} },
    [E.session_cost]: { state: "0", attributes: { unit_of_measurement: "GBP" } },
    [E.add_timer]: { state: "unknown", attributes: {} },
  };
  timers.forEach(([start, end, amps], i) => {
    const n = i + 1;
    s[`number.${C}_charge_schedule_${n}_current`] = { state: String(amps), attributes: { unit_of_measurement: "A" } };
    s[`time.${C}_charge_schedule_${n}_start`] = { state: start, attributes: {} };
    s[`time.${C}_charge_schedule_${n}_end`] = { state: end, attributes: {} };
    s[`button.${C}_delete_charge_schedule_${n}`] = { state: "unknown", attributes: {} };
  });
  return { ...s, ...extra };
}
const on = (...ids) => Object.fromEntries(ids.map((id) => [id, { state: "on", attributes: {} }]));

// A page with the script loaded, its clock at `now` (HH:MM today). `stored`
// is the folded blocks saved for this person; `page` what the page's own
// hass answers (for adding the dashboard). Home Assistant's card helpers
// arrive once `helpers` resolves (straight away without it), and `refuse`
// has Home Assistant refuse every action.
function page({ stored, page: pageHass, now = "12:00", helpers, refuse = false } = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "http://ha.local/charger/charger" });
  const { window } = dom;
  const [h, m] = now.split(":").map(Number);
  const fixed = new Date(2026, 10, 18, h, m).getTime();
  const RealDate = window.Date;
  window.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  window.loadCardHelpers = async () => (await helpers, {
    createCardElement(config) {
      const el = window.document.createElement("stub-card");
      el.config = config;
      return el;
    },
  });
  if (pageHass) {
    const ha = window.document.createElement("home-assistant");
    ha.hass = pageHass;
    window.document.body.appendChild(ha);
  }
  window.eval(SCRIPT);
  const saved = [];
  const services = [];
  const ws = { stored };
  const callWS = async (msg) => {
    if (msg.type === "eo_lite/config") return SETUP;
    if (msg.type === "frontend/get_user_data") return { value: ws.stored };
    if (msg.type === "frontend/set_user_data") { saved.push(plain(msg)); ws.stored = msg.value; return {}; }
    throw new Error(`unexpected ${msg.type}`);
  };
  // As Home Assistant's: it answers with a promise, which fails when it refuses.
  const callService = async (domain, service, data, target) => {
    services.push(plain({ domain, service, data, target }));
    if (refuse) throw new Error("Unauthorized");
  };
  return { window, callWS, callService, saved, services };
}

// The Charger dashboard as its strategy builds it, with its card on the page.
async function setup(options) {
  const { window, callWS, callService, saved, services } = page(options);
  const strategy = window.customElements.get("ll-strategy-dashboard-eo-lite");
  const dashboard = await strategy.generate({ type: "custom:eo-lite" }, { callWS, config: { state: "RUNNING" } });
  const config = dashboard.views[0].sections[0].cards[0];
  const card = window.document.createElement("eo-lite-charger");
  card.setConfig(config);
  window.document.body.appendChild(card);
  // EO-Lite's subscription, when `live` is given: `push` sends it a message.
  // (Or `connection`, a websocket connection of the test's own.)
  const live = { subscribed: [], stopped: 0, push: null };
  const connection = options?.connection || {
    subscribeMessage(callback, msg) {
      live.subscribed.push(msg);
      live.push = async (message) => { callback(message); await tick(); };
      return Promise.resolve(() => { live.stopped += 1; });
    },
  };
  const show = async (s) => {
    card.hass = { states: s, callWS, callService, ...(options?.live || options?.connection ? { connection } : {}) };
    await tick(); await tick();
  };
  const root = card.shadowRoot;
  const $ = (sel) => root.querySelector(sel);
  const blocks = () => [...root.querySelectorAll(".block")];
  const block = (id) => blocks().find((b) => b.dataset.id === id);
  const titles = () => blocks().map((b) => b.querySelector(".title").textContent);
  const summary = (id) => block(id).querySelector(".summary").textContent;
  const cards = (id) => [...block(id).querySelectorAll(".body > stub-card")];
  const shown = (sel) => !$(sel).hidden;
  const note = () => ($(".note").hidden ? "" : $(".note").textContent);
  const line = () => `${$(".top .name").textContent} · ${$(".top .state").textContent}`;
  // Each stretch on the strip as [from, width], in percent of the day.
  const spans = () => [...root.querySelectorAll(".track .span")].map((s) => [parseFloat(s.style.left), parseFloat(s.style.width)]);
  return { window, dashboard: plain(dashboard), config: plain(config), card, root, $, show, blocks, block, titles, summary, cards, shown, note, line, spans, saved, services, live };
}

const NIGHT = ["23:30:00", "05:30:00", 32];
const PEAK = ["16:00:00", "19:00:00", 6];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---- The dashboard ---------------------------------------------------------

test("the strategy builds one view holding the charger card", async () => {
  const d = await setup();
  assert.equal(d.dashboard.views.length, 1);
  const view = d.dashboard.views[0];
  assert.deepEqual([view.title, view.path, view.type], ["Charger", "charger", "sections"]);
  assert.equal(d.config.type, "custom:eo-lite-charger");
  assert.equal(d.config.charger, C);
  // Nothing on it switches the charger's own switches, or its overall current limit.
  const text = JSON.stringify(d.config.more);
  assert.ok(!text.includes(E.charging_switch) && !text.includes(E.timers_switch) && !text.includes("current_limit"));
});

test("while EO-Lite isn't set up, the dashboard says so", async () => {
  const { window } = page();
  const strategy = window.customElements.get("ll-strategy-dashboard-eo-lite");
  const callWS = async () => { throw new Error("not_loaded"); };
  const starting = await strategy.generate({}, { callWS, config: { state: "STARTING" } });
  assert.equal(starting.views[0].cards[0].content, "EO-Lite is starting…");
  const missing = await strategy.generate({}, { callWS, config: { state: "RUNNING" } });
  assert.match(missing.views[0].cards[0].content, /isn't set up/);
});

test("the status card first, then each timer, New timer, then power", async () => {
  const d = await setup();
  await d.show(states([NIGHT, PEAK]));
  const order = [...d.$(".blocks").children].map((el) => el.dataset.id || el.classList[0]);
  assert.deepEqual(order, ["status", "timer_1", "timer_2", "new", "power"]);
  assert.equal(d.$("h2").textContent, "Charger");
  // The status card doesn't fold.
  assert.equal(d.$(".status .chev"), null);
});

// ---- The status card ----------------------------------------------------------

test("it says what the charger's doing, and shows power while charging", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  assert.equal(d.line(), "Ready · No car plugged in");
  assert.equal(d.$(".status").className, "status idle");
  assert.equal(d.shown(".reading"), false);
  await d.show(states([NIGHT], on(E.vehicle_connected, E.allow_charging)));
  assert.equal(d.line(), "Plugged in · Not charging");
  assert.equal(d.$(".status").className, "status waiting lit");
  await d.show(states([NIGHT], {
    ...on(E.vehicle_connected, E.charging_active, E.allow_charging),
    [E.power]: { state: "7200", attributes: { unit_of_measurement: "W" } },
    [E.vehicle_current]: { state: "31.44", attributes: {} },
    [E.session_kwh]: { state: "12.345", attributes: {} },
  }));
  assert.equal(d.line(), "Charging · 31.4 A · 12.35 kWh so far");
  assert.equal(d.$(".status").className, "status charging lit");
  assert.equal(d.shown(".reading"), true);
  assert.equal(d.$(".reading .value").textContent, "7.2");
});

test("plugged in, it says why it isn't charging", async () => {
  const d = await setup({ now: "12:00" });
  await d.show(states([NIGHT, PEAK], on(E.vehicle_connected)));
  assert.equal(d.line(), "Plugged in · Charging is off");
  // Only during timers: the next one to start, 16:00 at noon.
  await d.show(states([NIGHT, PEAK], on(E.vehicle_connected, E.allow_charging, E.only_during_timers)));
  assert.equal(d.line(), "Plugged in · Charges from 16:00");
  // After 19:00 it's 23:30's.
  const late = await setup({ now: "20:15" });
  await late.show(states([NIGHT, PEAK], on(E.vehicle_connected, E.allow_charging, E.only_during_timers)));
  assert.equal(late.line(), "Plugged in · Charges from 23:30");
});

test("a charger that isn't answering", async () => {
  const d = await setup();
  const gone = states([NIGHT]);
  for (const id of Object.keys(gone)) if (id.includes(C)) gone[id] = { state: "unavailable", attributes: {} };
  await d.show(gone);
  assert.equal(d.line(), "Not answering · Home Assistant can't reach the charger");
  assert.match(d.$(".status").className, /unavailable/);
  assert.equal(d.note(), "The charger isn't answering, so timers can't be added.");
  assert.equal(d.shown(".add"), false);
});

test("tapping the charger opens its history", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  let opened = null;
  d.card.addEventListener("hass-more-info", (ev) => { opened = ev.detail.entityId; });
  d.$(".top").click();
  assert.equal(opened, E.state);
});

test("the toggles say what they mean, Only during timers under Allow charging while it's on", async () => {
  const d = await setup();
  await d.show(states([NIGHT, PEAK]));
  assert.equal(d.$(".allow .hint").textContent, "The car won't charge, timers included");
  assert.equal(d.$(".allow ha-switch").checked, false);
  assert.equal(d.shown(".timed"), false);
  await d.show(states([NIGHT, PEAK], on(E.allow_charging)));
  assert.equal(d.$(".allow .hint").textContent, "Whenever the car's plugged in");
  assert.equal(d.shown(".timed"), true);
  assert.equal(d.$(".timed ha-switch").checked, false);
  assert.equal(d.$(".timed .hint").textContent, "23:30–05:30 · 16:00–19:00");
  await d.show(states([NIGHT, PEAK], on(E.allow_charging, E.only_during_timers)));
  assert.equal(d.$(".allow .hint").textContent, "Only during the timers");
  assert.equal(d.$(".timed ha-switch").checked, true);
  assert.ok(d.$(".allow").classList.contains("on") && d.$(".timed").classList.contains("on"));
  // Before EO-Lite has seen the charger, its toggles aren't on or off.
  await d.show(states([], { [E.allow_charging]: { state: "unknown", attributes: {} } }));
  assert.equal(d.$(".allow .hint").textContent, "Waiting for the charger");
});

test("switching a toggle switches EO-Lite's switch", async () => {
  const d = await setup();
  await d.show(states([NIGHT], on(E.allow_charging)));
  const toggle = d.$(".timed ha-switch");
  toggle.checked = true;
  toggle.dispatchEvent(new d.window.Event("change"));
  const allow = d.$(".allow ha-switch");
  allow.checked = false;
  allow.dispatchEvent(new d.window.Event("change"));
  assert.deepEqual(d.services, [
    { domain: "switch", service: "turn_on", data: {}, target: { entity_id: E.only_during_timers } },
    { domain: "switch", service: "turn_off", data: {}, target: { entity_id: E.allow_charging } },
  ]);
});

test("the day's timers show on a strip while they decide, with now marked", async () => {
  const d = await setup({ now: "06:00" });
  await d.show(states([NIGHT, PEAK], on(E.allow_charging)));
  // Charging any time: the timers don't decide, so no strip.
  assert.equal(d.shown(".day"), false);
  await d.show(states([NIGHT, PEAK], on(E.allow_charging, E.only_during_timers)));
  assert.equal(d.shown(".day"), true);
  // 23:30–05:30 runs past midnight, so it's two stretches; then 16:00–19:00.
  assert.deepEqual(d.spans(), [[97.92, 2.08], [0, 22.92], [66.67, 12.5]]);
  assert.equal(parseFloat(d.$(".track .now").style.left), 25);
});

test("a toggle Home Assistant refuses goes back to how it is", async () => {
  // Someone who may not control the charger: Home Assistant refuses their toggles.
  const d = await setup({ refuse: true });
  const s = states([NIGHT]);
  await d.show(s);
  const allow = d.$(".allow ha-switch");
  allow.checked = true;
  allow.dispatchEvent(new d.window.Event("change"));
  await tick(); await tick();
  // It shows Allow charging off, as it still is, before anything else changes.
  assert.equal(d.services.length, 1);
  assert.equal(allow.checked, false);
  assert.equal(d.$(".allow .hint").textContent, "The car won't charge, timers included");
});

// ---- The timers ---------------------------------------------------------------

test("every timer the charger has gets a block, with its times and current on the heading", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  assert.deepEqual(d.titles(), ["Timer 1", "Power"]);
  assert.equal(d.summary("timer_1"), "23:30–05:30 · 32 A");
  // New timer is there even with one timer: the charger has no fixed number of them.
  assert.equal(d.shown(".add"), true);
  assert.equal(d.note(), "");
  // A time not set yet shows as dashes.
  await d.show(states([["unknown", "05:30:00", 20]]));
  assert.equal(d.summary("timer_1"), "--:--–05:30 · 20 A");
});

test("each timer's block holds its settings, and Delete unless it's the only one and the charger's default", async () => {
  const d = await setup();
  await d.show(states([["22:00:00", "06:00:00", 16]]));
  const rows = (n) => plain(d.cards(`timer_${n}`)[0].config).entities;
  const [settings] = d.cards("timer_1");
  // The only timer, at the charger's default, can't be deleted: the charger would only put it back.
  assert.deepEqual(rows(1).map((r) => [r.entity, r.name]), [
    [`time.${C}_charge_schedule_1_start`, "From"],
    [`time.${C}_charge_schedule_1_end`, "Until"],
    [`number.${C}_charge_schedule_1_current`, "Charge current"],
  ]);
  // With two, each has Delete, at the end of its card.
  await d.show(states([NIGHT, PEAK]));
  assert.equal(d.cards("timer_1").length, 1);
  assert.equal(rows(1).at(-1).name, "Delete this timer");
  const action = rows(2).at(-1).tap_action;
  assert.equal(action.target.entity_id, `button.${C}_delete_charge_schedule_2`);
  assert.equal(action.confirmation.text, "Delete timer 2? The timers after it move up a number.");
  // New timer presses the charger's add button.
  const add = plain(d.$(".add > stub-card").config).entities[0];
  assert.equal(add.tap_action.perform_action, "button.press");
  assert.equal(add.tap_action.target.entity_id, E.add_timer);
  // The cards inside are handed hass.
  assert.ok(settings.hass.states["light.kitchen"]);
  // Back to one, of your own: Delete resets it, and says so.
  await d.show(states([NIGHT]));
  assert.equal(rows(1).at(-1).tap_action.confirmation.text, "Timer 1 is the only one, so the charger keeps it, back at 22:00–06:00 at 16 A. Reset it?");
  // Reset: Delete goes again.
  await d.show(states([["22:00:00", "06:00:00", 16]]));
  assert.equal(rows(1).length, 3);
});

test("a new timer appears without disturbing the others", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  await d.show(states([NIGHT, PEAK]));
  const first = d.block("timer_1");
  first.querySelector(".head").click();
  const firstCard = first.querySelector("stub-card");
  // New timer pressed: the charger adds 22:00–06:00 at 16 A.
  await d.show(states([NIGHT, PEAK, ["22:00:00", "06:00:00", 16]]));
  assert.deepEqual(d.titles(), ["Timer 1", "Timer 2", "Timer 3", "Power"]);
  assert.equal(d.block("timer_1"), first);
  assert.equal(first.querySelector("stub-card"), firstCard);
  // The one that was folded still is; the new one starts open.
  assert.equal(first.classList.contains("collapsed"), true);
  assert.equal(d.block("timer_3").classList.contains("collapsed"), false);
  assert.equal(d.summary("timer_3"), "22:00–06:00 · 16 A");
});

test("there's no limit on timers", async () => {
  const d = await setup();
  await d.show(states(Array.from({ length: 9 }, () => NIGHT)));
  assert.deepEqual(d.titles().slice(0, -1), [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `Timer ${n}`));
  assert.equal(d.shown(".add"), true);
});

test("deleting a timer moves the later ones up, and the last one's block goes", async () => {
  const d = await setup({ stored: { collapsed: ["timer_3"] } });
  await d.show(states([NIGHT, PEAK, ["12:00:00", "14:00:00", 10]]));
  assert.equal(d.block("timer_3").classList.contains("collapsed"), true);
  // Timer 2 deleted: the charger's timer 3 is now its timer 2.
  await d.show(states([NIGHT, ["12:00:00", "14:00:00", 10]]));
  assert.deepEqual(d.titles(), ["Timer 1", "Timer 2", "Power"]);
  assert.equal(d.summary("timer_2"), "12:00–14:00 · 10 A");
  // Timer 3's folded state is forgotten, so a new timer 3 starts open.
  assert.deepEqual(d.saved.at(-1).value, { collapsed: [] });
});


test("a timer that can be deleted once Home Assistant's cards arrive holds one card", async () => {
  // A slow page: Home Assistant's cards take a while to arrive.
  let arrive;
  const d = await setup({ helpers: new Promise((r) => { arrive = r; }) });
  // One timer, the charger's default: no Delete. Before the cards arrive, a second
  // timer appears, so the first can now be deleted.
  await d.show(states([["22:00:00", "06:00:00", 16]]));
  await d.show(states([["22:00:00", "06:00:00", 16], PEAK]));
  arrive();
  await tick(); await tick();
  // Timer 1 holds its settings once, with Delete.
  const cards = d.cards("timer_1");
  assert.equal(cards.length, 1);
  assert.equal(plain(cards[0].config).entities.at(-1).name, "Delete this timer");
});

// ---- Timers by openeo's ids ----------------------------------------------------------

// Timer n's entities as Home Assistant names them once the charger's in an area.
const garden = (n) => ({
  n,
  current: `number.front_garden_openeo_charger_charge_schedule_${n}_current`,
  start: `time.front_garden_openeo_charger_charge_schedule_${n}_start`,
  end: `time.front_garden_openeo_charger_charge_schedule_${n}_end`,
  remove: `button.front_garden_openeo_charger_delete_charge_schedule_${n}`,
});
const plainTimer = (n) => ({
  n,
  current: `number.${C}_charge_schedule_${n}_current`,
  start: `time.${C}_charge_schedule_${n}_start`,
  end: `time.${C}_charge_schedule_${n}_end`,
  remove: `button.${C}_delete_charge_schedule_${n}`,
});
// States for these timers ({n, current, start, end}: entity ids, with [start, end, amps]).
function liveStates(timers, extra = {}) {
  const s = states([], extra);
  for (const [t, [start, end, amps]] of timers) {
    s[t.current] = { state: String(amps), attributes: { unit_of_measurement: "A" } };
    s[t.start] = { state: start, attributes: {} };
    s[t.end] = { state: end, attributes: {} };
    s[t.remove] = { state: "unknown", attributes: {} };
  }
  return s;
}
const DEFAULT = { start: "22:00", end: "06:00", amps: 16 };

test("timers Home Assistant named after the charger's area show up", async () => {
  const d = await setup({ live: true });
  const timers = [[plainTimer(1), NIGHT], [garden(2), PEAK], [garden(3), ["22:00:00", "06:00:00", 16]]];
  await d.show(liveStates(timers));
  assert.deepEqual(plain(d.live.subscribed), [{ type: "eo_lite/subscribe" }]);
  await d.live.push({ entities: SETUP.entities, timers: timers.map(([t]) => t), default_timer: DEFAULT });
  assert.deepEqual(d.titles(), ["Timer 1", "Timer 2", "Timer 3", "Power"]);
  assert.equal(d.summary("timer_2"), "16:00–19:00 · 6 A");
  const rows = plain(d.cards("timer_2")[0].config).entities;
  assert.equal(rows[0].entity, "time.front_garden_openeo_charger_charge_schedule_2_start");
  assert.equal(rows.at(-1).tap_action.target.entity_id, "button.front_garden_openeo_charger_delete_charge_schedule_2");
  // Each can be deleted, as there are several.
  assert.equal(plain(d.cards("timer_3")[0].config).entities.at(-1).name, "Delete this timer");
});

test("a timer added on the charger appears as EO-Lite says, and a deleted one goes", async () => {
  const d = await setup({ live: true });
  let timers = [[plainTimer(1), NIGHT]];
  await d.show(liveStates(timers));
  await d.live.push({ entities: SETUP.entities, timers: timers.map(([t]) => t), default_timer: DEFAULT });
  assert.deepEqual(d.titles(), ["Timer 1", "Power"]);
  // New timer pressed: its entities arrive, then EO-Lite says which they are.
  timers = [...timers, [garden(2), ["22:00:00", "06:00:00", 16]]];
  await d.show(liveStates(timers));
  assert.deepEqual(d.titles(), ["Timer 1", "Power"]);
  await d.live.push({ entities: SETUP.entities, timers: timers.map(([t]) => t), default_timer: DEFAULT });
  assert.deepEqual(d.titles(), ["Timer 1", "Timer 2", "Power"]);
  assert.equal(d.summary("timer_2"), "22:00–06:00 · 16 A");
  // Deleted: gone.
  timers = timers.slice(0, 1);
  await d.live.push({ entities: SETUP.entities, timers: timers.map(([t]) => t), default_timer: DEFAULT });
  await d.show(liveStates(timers));
  assert.deepEqual(d.titles(), ["Timer 1", "Power"]);
});

test("the charger's entities follow EO-Lite, and the subscription stops when the card goes", async () => {
  const d = await setup({ live: true });
  const renamed = { ...SETUP.entities, add_timer: "button.front_garden_add_charge_schedule" };
  const s = liveStates([[plainTimer(1), NIGHT]]);
  delete s[E.add_timer];
  s["button.front_garden_add_charge_schedule"] = { state: "unknown", attributes: {} };
  await d.show(s);
  // Before EO-Lite says, the add button isn't found, so New timer can't show.
  assert.equal(d.shown(".add"), false);
  await d.live.push({ entities: renamed, timers: [plainTimer(1)], default_timer: DEFAULT });
  assert.equal(d.shown(".add"), true);
  d.card.remove();
  await tick();
  assert.equal(d.live.stopped, 1);
});

test("a timer's settings follow its entities as EO-Lite says, not as guessed by name", async () => {
  const d = await setup({ live: true });
  // Timer 1's start was renamed. Until EO-Lite says, its entities are guessed by name.
  const t1 = { ...plainTimer(1), start: "time.garage_timer_start" };
  await d.show(liveStates([[t1, NIGHT]]));
  await d.live.push({ entities: SETUP.entities, timers: [t1], default_timer: DEFAULT });
  // Its settings use the renamed one.
  const rows = plain(d.cards("timer_1")[0].config).entities;
  assert.equal(rows[0].entity, "time.garage_timer_start");
  assert.equal(d.summary("timer_1"), "23:30–05:30 · 32 A");
});

test("a new timer whose entities arrive one by one ends up with all its settings", async () => {
  const d = await setup({ live: true });
  const t1 = plainTimer(1);
  const t2 = garden(2);
  const timers = [[t1, NIGHT], [t2, PEAK]];
  await d.show(liveStates(timers));
  // openeo's entities for timer 2 are registered one at a time, and EO-Lite says so after each.
  await d.live.push({ entities: SETUP.entities, timers: [t1, { n: 2, current: t2.current }], default_timer: DEFAULT });
  await d.live.push({ entities: SETUP.entities, timers: [t1, { n: 2, current: t2.current, start: t2.start }], default_timer: DEFAULT });
  await d.live.push({ entities: SETUP.entities, timers: [t1, t2], default_timer: DEFAULT });
  await d.show(liveStates(timers));
  // Timer 2's card has every one of them.
  const rows = plain(d.cards("timer_2")[0].config).entities;
  assert.deepEqual(rows.map((r) => r.entity ?? r.tap_action?.target.entity_id), [t2.start, t2.end, t2.current, t2.remove]);
  assert.equal(d.cards("timer_2").length, 1);
});

// ---- Power and folding -----------------------------------------------------------

test("Power sums up the session", async () => {
  const d = await setup();
  await d.show(states([NIGHT], {
    [E.session_kwh]: { state: "12.345", attributes: {} },
    [E.session_cost]: { state: "1.5", attributes: { unit_of_measurement: "GBP" } },
  }));
  assert.equal(d.summary("power"), "This session: 12.35 kWh · £1.50");
  await d.show(states([NIGHT], { [E.session_cost]: { state: "2", attributes: { unit_of_measurement: "SEK" } } }));
  assert.equal(d.summary("power"), "This session: 0.00 kWh · 2.00 SEK");
  assert.deepEqual(d.cards("power").map((c) => [c.config.type, c.config.entity]), [["sensor", E.power], ["tile", E.session_kwh], ["tile", E.session_cost]]);
});

test("tapping a heading folds its block, and that's saved", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  const power = d.block("power");
  power.querySelector(".head").click();
  assert.equal(power.classList.contains("collapsed"), true);
  assert.equal(power.querySelector(".head").getAttribute("aria-expanded"), "false");
  assert.deepEqual(d.saved.at(-1), { type: "frontend/set_user_data", key: "eo_lite_charger", value: { collapsed: ["power"] } });
  power.querySelector(".head").dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(power.classList.contains("collapsed"), false);
});

test("tapping Charger folds the whole card", async () => {
  const d = await setup();
  await d.show(states([NIGHT]));
  d.$(".card-head").click();
  assert.equal(d.$(".card").classList.contains("folded"), true);
  assert.deepEqual(d.saved.at(-1).value, { collapsed: ["all"] });
});

test("opens as each person left it", async () => {
  const d = await setup({ stored: { collapsed: ["timer_2", 7, "power"] } });
  await d.show(states([NIGHT, PEAK]));
  assert.deepEqual(d.blocks().filter((b) => b.classList.contains("collapsed")).map((b) => b.dataset.id), ["timer_2", "power"]);
});

test("other things changing around the house don't redraw it", async () => {
  const d = await setup();
  const s = states([NIGHT]);
  await d.show(s);
  const heading = d.block("timer_1").querySelector(".summary");
  heading.textContent = "untouched";
  await d.show({ ...s, "light.kitchen": { state: "off", attributes: {} } });
  assert.equal(heading.textContent, "untouched");
});

// ---- Adding the dashboard -------------------------------------------------------

// The page's own hass, answering as Home Assistant would; `calls` are what it's asked.
function pageHass({ admin = true, add = true, dashboards = [], configs = {}, fail } = {}) {
  const calls = [];
  const callWS = async (msg) => {
    calls.push(plain(msg));
    if (msg.type === "eo_lite/config") return { ...SETUP, add_dashboard: add };
    if (msg.type === "eo_lite/claim_dashboard") return { claimed: !msg.release };
    if (msg.type === "lovelace/dashboards/list") return dashboards;
    if (msg.type === "lovelace/config") { if (configs[msg.url_path]) return configs[msg.url_path]; throw new Error("no config"); }
    if (msg.type === fail) throw new Error("it broke");
    return {};
  };
  return { hass: { user: { is_admin: admin }, connection: {}, panels: {}, callWS }, calls };
}
const types = (calls) => calls.map((c) => c.type);

test("an admin's browser adds the Charger dashboard", async () => {
  const { hass, calls } = pageHass({ dashboards: [{ url_path: "lights" }], configs: { lights: { strategy: { type: "custom:hue-lite" } } } });
  page({ page: hass });
  await tick(); await tick(); await tick();
  const create = calls.find((c) => c.type === "lovelace/dashboards/create");
  assert.deepEqual([create.url_path, create.title, create.icon, create.show_in_sidebar], ["charger", "Charger", "mdi:ev-station", true]);
  assert.deepEqual(calls.at(-1), { type: "lovelace/config/save", url_path: "charger", config: { strategy: { type: "custom:eo-lite" } } });
});

test("the dashboard isn't added twice, or by someone who isn't an admin, or when it's turned off", async () => {
  let p = pageHass({ dashboards: [{ url_path: "ev" }], configs: { ev: { strategy: { type: "custom:eo-lite" } } } });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.ok(!types(p.calls).includes("lovelace/dashboards/create"));
  p = pageHass({ admin: false });
  page({ page: p.hass });
  await tick(); await tick();
  assert.deepEqual(p.calls, []);
  p = pageHass({ add: false });
  page({ page: p.hass });
  await tick(); await tick();
  assert.deepEqual(types(p.calls), ["eo_lite/config"]);
});

test("a dashboard already at /charger is left alone, and a failure gives the claim back", async () => {
  let p = pageHass({ dashboards: [{ url_path: "charger" }], configs: { charger: { views: [] } } });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.equal(p.calls.find((c) => c.type === "lovelace/dashboards/create").url_path, "eo-lite-charger");
  p = pageHass({ fail: "lovelace/dashboards/create" });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.deepEqual(p.calls.at(-1), { type: "eo_lite/claim_dashboard", release: true, error: "it broke" });
});

// ---- Names and states stay text -------------------------------------------------

test("hostile names, states and units are shown as text, never as markup", async () => {
  const X = `"><img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
  const { window } = page();
  const Card = window.customElements.get("eo-lite-charger");
  // A hostile charger is refused outright.
  assert.throws(() => new Card().setConfig({ charger: X, entities: {} }));
  const card = window.document.createElement("eo-lite-charger");
  card.setConfig({ charger: C, entities: E, more: [{ id: X, name: X, icon: X, cards: [] }] });
  window.document.body.appendChild(card);
  const hostile = (state, unit) => ({ state, attributes: { unit_of_measurement: unit, friendly_name: X } });
  card.hass = {
    states: {
      ...states([]),
      [E.state]: hostile(X), [E.power]: hostile(X, X), [E.session_cost]: hostile("1", X), [E.session_kwh]: hostile(X),
      [E.allow_charging]: hostile("on"), [E.only_during_timers]: hostile("on"), [E.charging_active]: hostile("on"),
      [E.vehicle_connected]: hostile("on"), [E.add_timer]: hostile(X),
      [`number.${C}_charge_schedule_1_current`]: hostile(X, X), [`time.${C}_charge_schedule_1_start`]: hostile(X),
      [`time.${C}_charge_schedule_1_end`]: hostile("06:00:00"),
    },
    callWS: async () => ({}),
    callService: async () => {},
  };
  await tick(); await tick();
  const root = card.shadowRoot;
  assert.equal(root.querySelectorAll("img, script").length, 0);
  assert.equal(window.pwned, undefined);
  assert.ok(root.textContent.includes("<img"), "hostile text is shown as text");
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed += 1; console.log(`FAIL ${name}\n     ${String(err.stack).split("\n").slice(0, 8).join("\n     ")}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
