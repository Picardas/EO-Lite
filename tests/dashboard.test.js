// The dashboard script in a stand-in browser (jsdom), with stand-ins for
// Home Assistant's cards, storage and websocket.
//   npm install --no-save jsdom && node tests/dashboard.test.js
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
    allow_charging: "switch.eo_lite_allow_charging",
    only_during_timers: "switch.eo_lite_only_during_timers",
  },
};
const E = SETUP.entities;

// A house whose charger has `slots` timer slots; `timers` gives the ones in
// use as {n: [start, end, amps]}, and `extra` any other states.
function states(slots, timers, extra = {}) {
  const s = {
    "light.kitchen": { state: "on", attributes: {} },
    [E.allow_charging]: { state: "off", attributes: {} },
    [E.only_during_timers]: { state: "off", attributes: {} },
    [E.charging_active]: { state: "off", attributes: {} },
    [E.vehicle_connected]: { state: "off", attributes: {} },
    [E.power]: { state: "0", attributes: { unit_of_measurement: "kW" } },
    [E.vehicle_current]: { state: "0", attributes: {} },
    [E.session_kwh]: { state: "0", attributes: {} },
    [E.session_cost]: { state: "0", attributes: { unit_of_measurement: "GBP" } },
  };
  for (let n = 1; n <= slots; n++) {
    const [start, end, amps] = timers[n] || ["00:00:00", "00:00:00", 0];
    s[`number.${C}_charge_schedule_${n}_current`] = { state: String(amps), attributes: { unit_of_measurement: "A" } };
    s[`time.${C}_charge_schedule_${n}_start`] = { state: start, attributes: {} };
    s[`time.${C}_charge_schedule_${n}_end`] = { state: end, attributes: {} };
    s[`button.${C}_delete_charge_schedule_${n}`] = { state: "unknown", attributes: {} };
  }
  return { ...s, ...extra };
}
const on = (...ids) => Object.fromEntries(ids.map((id) => [id, { state: "on", attributes: {} }]));

// A page with the script loaded. `stored` is the folded blocks saved for this
// person; `page` what the page's own hass answers (for adding the dashboard).
function page({ stored, page: pageHass } = {}) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only", url: "http://ha.local/charger/charger" });
  const { window } = dom;
  window.loadCardHelpers = async () => ({
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
  const ws = { stored };
  const callWS = async (msg) => {
    if (msg.type === "eo_lite/config") return SETUP;
    if (msg.type === "frontend/get_user_data") return { value: ws.stored };
    if (msg.type === "frontend/set_user_data") { saved.push(plain(msg)); ws.stored = msg.value; return {}; }
    throw new Error(`unexpected ${msg.type}`);
  };
  return { window, callWS, saved };
}

// The Charger dashboard as its strategy builds it, with its card on the page.
async function setup(options) {
  const { window, callWS, saved } = page(options);
  const strategy = window.customElements.get("ll-strategy-dashboard-eo-lite");
  const dashboard = await strategy.generate({ type: "custom:eo-lite" }, { callWS, config: { state: "RUNNING" } });
  const config = dashboard.views[0].sections[0].cards[0];
  const card = window.document.createElement("eo-lite-charger");
  card.setConfig(config);
  window.document.body.appendChild(card);
  const show = async (s) => { card.hass = { states: s, callWS }; await tick(); await tick(); };
  const root = card.shadowRoot;
  const blocks = () => [...root.querySelectorAll(".block")];
  const block = (id) => blocks().find((b) => b.dataset.id === id);
  const titles = () => blocks().map((b) => b.querySelector(".title").textContent);
  const summary = (id) => block(id).querySelector(".summary").textContent;
  const cards = (id) => [...block(id).querySelectorAll(".body > stub-card")].map((c) => plain(c.config));
  const addShown = () => !root.querySelector(".add").hidden;
  const note = () => (root.querySelector(".note").hidden ? "" : root.querySelector(".note").textContent);
  return { window, dashboard: plain(dashboard), config: plain(config), card, root, show, blocks, block, titles, summary, cards, addShown, note, saved };
}

const NIGHT = ["23:30:00", "05:30:00", 16];
const NOON = ["12:00:00", "14:15:00", 10.5];
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
  const text = JSON.stringify(d.config.blocks) + JSON.stringify(d.config.more);
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

test("the blocks: now, when to charge, the timers, then power", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT, 3: NOON }));
  assert.deepEqual(d.titles(), ["Now", "When to charge", "Timer 1", "Timer 3", "Power"]);
  assert.equal(d.root.querySelector("h2").textContent, "Charger");
  // New timer comes after the timers, before Power.
  const order = [...d.root.querySelector(".blocks").children].map((el) => el.dataset.id || el.className);
  assert.deepEqual(order, ["now", "when", "timer_1", "timer_3", "new", "power"]);
});

test("both toggles are in one block, Only during timers under Allow charging while it's on", async () => {
  const d = await setup();
  await d.show(states(4, {}));
  const [entities] = d.cards("when");
  assert.equal(entities.type, "entities");
  assert.deepEqual(entities.entities[0], { entity: E.allow_charging, name: "Allow charging" });
  assert.deepEqual(entities.entities[1], {
    type: "conditional",
    conditions: [{ entity: E.allow_charging, state: "on" }],
    row: { entity: E.only_during_timers, name: "Only during timers" },
  });
});

// ---- The summaries -----------------------------------------------------------

test("When to charge says what the toggles mean", async () => {
  const d = await setup();
  const timers = { 1: NIGHT, 3: NOON };
  await d.show(states(4, timers));
  assert.equal(d.summary("when"), "Off");
  // Only during timers alone doesn't allow charging.
  await d.show(states(4, timers, on(E.only_during_timers)));
  assert.equal(d.summary("when"), "Off");
  await d.show(states(4, timers, on(E.allow_charging)));
  assert.equal(d.summary("when"), "Whenever the car's plugged in");
  await d.show(states(4, timers, on(E.allow_charging, E.only_during_timers)));
  assert.equal(d.summary("when"), "Only 23:30–05:30 · 12:00–14:15");
  await d.show(states(4, {}, on(E.allow_charging, E.only_during_timers)));
  assert.equal(d.summary("when"), "Only during timers: none yet");
  // Before EO-Lite has seen the charger, its toggles aren't on or off.
  await d.show(states(4, {}, { [E.allow_charging]: { state: "unknown", attributes: {} } }));
  assert.equal(d.summary("when"), "Waiting for the charger");
});

test("Now says what the charger's doing", async () => {
  const d = await setup();
  await d.show(states(4, {}));
  assert.equal(d.summary("now"), "No car plugged in");
  await d.show(states(4, {}, on(E.vehicle_connected)));
  assert.equal(d.summary("now"), "Car plugged in · not charging");
  await d.show(states(4, {}, {
    ...on(E.vehicle_connected, E.charging_active),
    [E.power]: { state: "7200", attributes: { unit_of_measurement: "W" } },
    [E.vehicle_current]: { state: "31.44", attributes: {} },
  }));
  assert.equal(d.summary("now"), "Charging at 7.2 kW · 31.4 A");
  await d.show(states(4, {}, { ...on(E.charging_active), [E.power]: { state: "3.6", attributes: { unit_of_measurement: "kW" } } }));
  assert.equal(d.summary("now"), "Charging at 3.6 kW · 0.0 A");
});

test("Power sums up the session", async () => {
  const d = await setup();
  await d.show(states(4, {}, {
    [E.session_kwh]: { state: "12.345", attributes: {} },
    [E.session_cost]: { state: "1.5", attributes: { unit_of_measurement: "GBP" } },
  }));
  assert.equal(d.summary("power"), "This session: 12.35 kWh · £1.50");
  await d.show(states(4, {}, { [E.session_cost]: { state: "2", attributes: { unit_of_measurement: "SEK" } } }));
  assert.equal(d.summary("power"), "This session: 0.00 kWh · 2.00 SEK");
  assert.deepEqual(d.cards("power").map((c) => [c.type, c.entity]), [["sensor", E.power], ["tile", E.session_kwh], ["tile", E.session_cost]]);
});

// ---- The timers ---------------------------------------------------------------

test("each timer's heading has its times and current", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT, 3: NOON }));
  assert.equal(d.summary("timer_1"), "23:30–05:30 · 16 A");
  assert.equal(d.summary("timer_3"), "12:00–14:15 · 10.5 A");
  assert.equal(d.addShown(), true);
  assert.equal(d.note(), "");
  // And follows them; a time not set yet shows as dashes.
  await d.show(states(4, { 1: ["unknown", "05:30:00", 20], 3: NOON }));
  assert.equal(d.summary("timer_1"), "--:--–05:30 · 20 A");
});

test("each timer's block holds its settings, its own current and its delete button", async () => {
  const d = await setup();
  await d.show(states(4, { 3: NOON }));
  const [entities] = d.cards("timer_3");
  assert.deepEqual(entities.entities.slice(0, 3).map((r) => [r.entity, r.name]), [
    [`time.${C}_charge_schedule_3_start`, "From"],
    [`time.${C}_charge_schedule_3_end`, "Until"],
    [`number.${C}_charge_schedule_3_current`, "Charge current"],
  ]);
  assert.equal(entities.entities[3].tap_action.target.entity_id, `button.${C}_delete_charge_schedule_3`);
  assert.equal(entities.entities[3].tap_action.confirmation.text, "Delete timer 3?");
  // New timer presses the charger's add button.
  const add = plain(d.root.querySelector(".add > stub-card").config).entities[0];
  assert.equal(add.tap_action.perform_action, "button.press");
  assert.equal(add.tap_action.target.entity_id, E.add_timer);
  // The cards inside are handed hass.
  assert.ok(d.block("timer_3").querySelector("stub-card").hass.states["light.kitchen"]);
  assert.ok(d.block("now").querySelector("stub-card").hass.states["light.kitchen"]);
});

test("a new timer appears in order without disturbing the others", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT, 3: NOON }));
  const first = d.block("timer_1");
  const third = d.block("timer_3");
  first.querySelector(".head").click();
  const firstCard = first.querySelector("stub-card");
  await d.show(states(4, { 1: NIGHT, 2: ["07:00:00", "08:00:00", 32], 3: NOON }));
  assert.deepEqual(d.titles(), ["Now", "When to charge", "Timer 1", "Timer 2", "Timer 3", "Power"]);
  assert.equal(d.block("timer_1"), first);
  assert.equal(d.block("timer_3"), third);
  assert.equal(first.querySelector("stub-card"), firstCard);
  // The one that was folded still is; the new one starts open.
  assert.equal(first.classList.contains("collapsed"), true);
  assert.equal(d.block("timer_2").classList.contains("collapsed"), false);
});

test("with every slot in use, New timer gives way to why", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT, 2: NOON, 3: NOON, 4: NOON }));
  assert.equal(d.addShown(), false);
  assert.equal(d.note(), "All 4 timers are in use. Delete one to add another.");
  // Deleting one brings New timer back.
  await d.show(states(4, { 1: NIGHT, 2: NOON, 4: NOON }));
  assert.deepEqual(d.titles(), ["Now", "When to charge", "Timer 1", "Timer 2", "Timer 4", "Power"]);
  assert.equal(d.addShown(), true);
  assert.equal(d.note(), "");
});

test("shows as many timers as the charger's integration has slots for", async () => {
  const d = await setup();
  const timers = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, NIGHT]));
  delete timers[11];
  await d.show(states(12, timers));
  assert.deepEqual(d.titles().slice(2, -1), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((n) => `Timer ${n}`));
  assert.equal(d.addShown(), true);
  await d.show(states(12, { ...timers, 11: NOON }));
  assert.equal(d.titles()[12], "Timer 11");
  assert.equal(d.addShown(), false);
  assert.equal(d.note(), "All 12 timers are in use. Delete one to add another.");
});

test("no timers yet", async () => {
  const d = await setup();
  // Empty slots report 0, or nothing at all.
  await d.show(states(4, {}, { [`number.${C}_charge_schedule_2_current`]: { state: "unknown", attributes: {} } }));
  assert.deepEqual(d.titles(), ["Now", "When to charge", "Power"]);
  assert.equal(d.note(), "No timers yet.");
  assert.equal(d.addShown(), true);
});

test("the charger not answering", async () => {
  const d = await setup({ stored: { collapsed: ["timer_1"] } });
  await d.show(states(4, { 1: NIGHT }));
  const gone = states(4, {});
  for (const id of Object.keys(gone)) if (id.includes(C)) gone[id] = { state: "unavailable", attributes: {} };
  await d.show(gone);
  assert.deepEqual(d.titles(), ["Now", "When to charge", "Power"]);
  assert.equal(d.note(), "The charger isn't answering.");
  assert.equal(d.addShown(), false);
  // Back again, its timer is folded as it was.
  await d.show(states(4, { 1: NIGHT }));
  assert.equal(d.block("timer_1").classList.contains("collapsed"), true);
  assert.equal(d.saved.length, 0);
});

test("a charger with no timers at all", async () => {
  const d = await setup();
  await d.show(states(0, {}));
  assert.equal(d.note(), "The charger has no timers.");
  assert.equal(d.addShown(), false);
});

// ---- Folding ------------------------------------------------------------------

test("tapping a heading folds its block, and that's saved", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT }));
  const power = d.block("power");
  assert.equal(power.querySelector(".head").getAttribute("aria-expanded"), "true");
  power.querySelector(".head").click();
  assert.equal(power.classList.contains("collapsed"), true);
  assert.equal(power.querySelector(".head").getAttribute("aria-expanded"), "false");
  assert.equal(d.block("timer_1").classList.contains("collapsed"), false);
  assert.deepEqual(d.saved.at(-1), { type: "frontend/set_user_data", key: "eo_lite_charger", value: { collapsed: ["power"] } });
  // Enter on the heading opens it again.
  power.querySelector(".head").dispatchEvent(new d.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(power.classList.contains("collapsed"), false);
  assert.deepEqual(d.saved.at(-1).value, { collapsed: [] });
});

test("tapping Charger folds the whole card", async () => {
  const d = await setup();
  await d.show(states(4, { 1: NIGHT }));
  d.root.querySelector(".card-head").click();
  assert.equal(d.root.querySelector(".card").classList.contains("folded"), true);
  assert.equal(d.root.querySelector(".card-head").getAttribute("aria-expanded"), "false");
  assert.deepEqual(d.saved.at(-1).value, { collapsed: ["all"] });
});

test("opens as each person left it", async () => {
  const d = await setup({ stored: { collapsed: ["timer_3", 7, "power"] } });
  await d.show(states(4, { 1: NIGHT, 3: NOON }));
  assert.deepEqual(d.blocks().filter((b) => b.classList.contains("collapsed")).map((b) => b.dataset.id), ["timer_3", "power"]);
  assert.equal(d.root.querySelector(".card").classList.contains("folded"), false);
});

test("a deleted timer's slot starts open for the next one", async () => {
  const d = await setup({ stored: { collapsed: ["timer_1"] } });
  await d.show(states(4, { 1: NIGHT, 3: NOON }));
  assert.equal(d.block("timer_1").classList.contains("collapsed"), true);
  await d.show(states(4, { 3: NOON }));
  assert.deepEqual(d.saved.at(-1).value, { collapsed: [] });
  await d.show(states(4, { 1: NOON, 3: NOON }));
  assert.equal(d.block("timer_1").classList.contains("collapsed"), false);
});

test("other things changing around the house don't redraw it", async () => {
  const d = await setup();
  const s = states(4, { 1: NIGHT });
  await d.show(s);
  const line = d.block("timer_1").querySelector(".summary");
  line.textContent = "untouched";
  await d.show({ ...s, "light.kitchen": { state: "off", attributes: {} } });
  assert.equal(line.textContent, "untouched");
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
  // One of EO-Lite's is already there.
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
  // The dashboard that was there before EO-Lite, with its own cards.
  let p = pageHass({ dashboards: [{ url_path: "charger" }], configs: { charger: { views: [] } } });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.equal(p.calls.find((c) => c.type === "lovelace/dashboards/create").url_path, "eo-lite-charger");
  p = pageHass({ fail: "lovelace/dashboards/create" });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.deepEqual(p.calls.at(-1), { type: "eo_lite/claim_dashboard", release: true, error: "it broke" });
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed += 1; console.log(`FAIL ${name}\n     ${String(err.stack).split("\n").slice(0, 8).join("\n     ")}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
