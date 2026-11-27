// The dashboard script in a stand-in browser (jsdom), with stand-ins for
// Home Assistant's cards, storage and websocket.
//   npm ci --ignore-scripts && node tests/dashboard.test.js
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");

const SCRIPT = fs.readFileSync(path.join(__dirname, "..", "custom_components", "eo_lite", "frontend", "eo-lite.js"), "utf8");
const tick = () => new Promise((r) => setTimeout(r, 0));
const plain = (value) => JSON.parse(JSON.stringify(value));

const C = "eo_mini_pro_2";
const SETUP = {
  charger: C,
  add_dashboard: false,
  entities: {
    charge_mode: `select.${C}_charge_mode`,
    timer_1_enabled: `switch.${C}_timer_1_enabled`,
    timer_1_start: `time.${C}_timer_1_start`,
    timer_1_end: `time.${C}_timer_1_end`,
    timer_2_enabled: `switch.${C}_timer_2_enabled`,
    timer_2_start: `time.${C}_timer_2_start`,
    timer_2_end: `time.${C}_timer_2_end`,
    mains_voltage_correction: `number.${C}_mains_voltage_correction`,
    reset_bridge: `button.${C}_reset_bridge`,
    charger_state: `sensor.${C}_charger_state`,
    current: `sensor.${C}_current`,
    voltage: `sensor.${C}_voltage`,
    power: `sensor.${C}_power`,
    frequency: `sensor.${C}_frequency`,
    session_energy: `sensor.${C}_session_energy`,
    energy_total: `sensor.${C}_energy_total`,
    cable_connected: `binary_sensor.${C}_cable_connected`,
    vehicle_connected: `binary_sensor.${C}_vehicle_connected`,
    charging_active: `binary_sensor.${C}_charging_active`,
    mains_fault: `binary_sensor.${C}_mains_fault`,
    controller_connected: `binary_sensor.${C}_controller_connected`,
    clock_synced: `binary_sensor.${C}_clock_synced`,
    cpu_temperature: `sensor.${C}_cpu_temperature`,
    wifi_rssi: `sensor.${C}_wifi_rssi`,
    rs485_errors: `sensor.${C}_rs485_errors`,
    eo_firmware_version: `sensor.${C}_eo_firmware_version`,
    hw_max_current: `sensor.${C}_hw_max_current`,
    watchdog_timeout: `sensor.${C}_watchdog_timeout`,
    watchdog_current: `sensor.${C}_watchdog_current`,
  },
};
const E = SETUP.entities;

function states(extra = {}) {
  const s = {
    "light.kitchen": { state: "on", attributes: {} },
    [E.charge_mode]: { state: "Off", attributes: { options: ["Off", "On", "Timer"] } },
    [E.timer_1_enabled]: { state: "off", attributes: {} },
    [E.timer_1_start]: { state: "00:30:00", attributes: {} },
    [E.timer_1_end]: { state: "04:30:00", attributes: {} },
    [E.timer_2_enabled]: { state: "off", attributes: {} },
    [E.timer_2_start]: { state: "00:00:00", attributes: {} },
    [E.timer_2_end]: { state: "00:00:00", attributes: {} },
    [E.mains_voltage_correction]: { state: "77.8", attributes: { unit_of_measurement: "%" } },
    [E.reset_bridge]: { state: "unknown", attributes: {} },
    [E.charger_state]: { state: "idle", attributes: {} },
    [E.current]: { state: "0.0", attributes: { unit_of_measurement: "A" } },
    [E.voltage]: { state: "234.4", attributes: { unit_of_measurement: "V" } },
    [E.power]: { state: "0", attributes: { unit_of_measurement: "W" } },
    [E.frequency]: { state: "50", attributes: { unit_of_measurement: "Hz" } },
    [E.session_energy]: { state: "0.000", attributes: { unit_of_measurement: "kWh" } },
    [E.energy_total]: { state: "123.456", attributes: { unit_of_measurement: "kWh" } },
    [E.cable_connected]: { state: "off", attributes: {} },
    [E.vehicle_connected]: { state: "off", attributes: {} },
    [E.charging_active]: { state: "off", attributes: {} },
    [E.mains_fault]: { state: "off", attributes: {} },
    [E.controller_connected]: { state: "on", attributes: {} },
    [E.clock_synced]: { state: "on", attributes: {} },
    [E.cpu_temperature]: { state: "42.1", attributes: { unit_of_measurement: "°C" } },
    [E.wifi_rssi]: { state: "-58", attributes: { unit_of_measurement: "dBm" } },
    [E.rs485_errors]: { state: "0", attributes: {} },
    [E.eo_firmware_version]: { state: "0x14", attributes: {} },
    [E.hw_max_current]: { state: "0.0", attributes: { unit_of_measurement: "A" } },
    [E.watchdog_timeout]: { state: "60", attributes: {} },
    [E.watchdog_current]: { state: "0", attributes: {} },
  };
  return { ...s, ...extra };
}
const on = (...ids) => Object.fromEntries(ids.map((id) => [id, { state: "on", attributes: {} }]));
const val = (id, state, unit) => ({ [id]: { state: String(state), attributes: unit ? { unit_of_measurement: unit } : {} } });

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
  const callService = async (domain, service, data, target) => {
    services.push(plain({ domain, service, data, target }));
    if (refuse) throw new Error("Unauthorized");
  };
  return { window, callWS, callService, saved, services };
}

async function setup(options) {
  const { window, callWS, callService, saved, services } = page(options);
  const strategy = window.customElements.get("ll-strategy-dashboard-eo-lite");
  const dashboard = await strategy.generate({ type: "custom:eo-lite" }, { callWS, config: { state: "RUNNING" } });
  const config = dashboard.views[0].sections[0].cards[0];
  const card = window.document.createElement("eo-lite-charger");
  card.setConfig(config);
  window.document.body.appendChild(card);
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
  const line = () => `${$(".top .name").textContent} · ${$(".top .state").textContent}`;
  const spans = () => [...root.querySelectorAll(".track .span")].map((s) => [parseFloat(s.style.left), parseFloat(s.style.width)]);
  const modeBtn = (m) => $(`.modes button[data-mode="${m}"]`);
  return { window, dashboard: plain(dashboard), config: plain(config), card, root, $, show, blocks, block, titles, summary, cards, shown, line, spans, modeBtn, saved, services, live };
}

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
  assert.equal(Object.keys(d.config.entities).length, 29);
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

test("blocks appear in order: status, timer_1, timer_2, power, diagnostics", async () => {
  const d = await setup();
  await d.show(states());
  const order = [...d.$(".blocks").children].map((el) => el.dataset.id || el.classList[0]);
  assert.deepEqual(order, ["status", "timer_1", "timer_2", "power", "diagnostics"]);
  assert.deepEqual(d.titles(), ["Timer 1", "Timer 2", "Power", "Diagnostics"]);
  assert.equal(d.$("h2").textContent, "Charger");
  assert.equal(d.$(".status .chev"), null);
});

// ---- The status card -------------------------------------------------------

test("it shows ready, cable connected, charging (W to kW), mains fault, controller offline, and unavailable", async () => {
  const d = await setup();
  await d.show(states());
  assert.equal(d.line(), "Ready · No car plugged in");
  assert.equal(d.$(".status").className, "status idle");
  assert.equal(d.shown(".reading"), false);

  await d.show(states({ ...on(E.cable_connected), ...val(E.charger_state, "plug-present") }));
  assert.equal(d.line(), "Cable connected · No vehicle connected");
  assert.equal(d.$(".status").className, "status waiting lit");

  await d.show(states({
    ...on(E.cable_connected, E.vehicle_connected, E.charging_active),
    ...val(E.charge_mode, "On"),
    ...val(E.charger_state, "charging"),
    ...val(E.power, "7315", "W"),
    ...val(E.current, "31.24", "A"),
    ...val(E.session_energy, "12.345", "kWh"),
  }));
  assert.equal(d.line(), "Charging · 31.2 A · 12.35 kWh so far");
  assert.equal(d.$(".status").className, "status charging lit");
  assert.equal(d.shown(".reading"), true);
  assert.equal(d.$(".reading .value").textContent, "7.3");

  await d.show(states({ ...on(E.mains_fault), ...val(E.charger_state, "mains-fault") }));
  assert.equal(d.line(), "Mains fault · Charging halted — check incoming mains");
  assert.equal(d.$(".status").className, "status fault lit");
  assert.equal(d.shown(".reading"), false);

  await d.show(states({ [E.controller_connected]: { state: "off", attributes: {} } }));
  assert.equal(d.line(), "Not answering · RS-485 link to power board lost");
  assert.match(d.$(".status").className, /unavailable/);

  await d.show(states({
    [E.charger_state]: { state: "unavailable", attributes: {} },
    [E.charging_active]: { state: "unavailable", attributes: {} },
  }));
  assert.equal(d.line(), "Not answering · Home Assistant can't reach the charger");
  assert.match(d.$(".status").className, /unavailable/);
});

test("plugged in, it distinguishes Off, Timer, complete, paused, suspended, and NTP sync wait", async () => {
  const d = await setup({ now: "20:15" });
  const plugged = { ...on(E.cable_connected, E.vehicle_connected), ...val(E.charger_state, "car-connected") };

  await d.show(states({ ...plugged, ...val(E.charge_mode, "Off") }));
  assert.equal(d.line(), "Plugged in · Charging is off");

  await d.show(states({
    ...plugged,
    ...val(E.charge_mode, "Timer"),
    ...on(E.timer_1_enabled),
    ...val(E.timer_1_start, "23:30:00"),
    ...val(E.timer_1_end, "05:30:00"),
  }));
  assert.equal(d.line(), "Plugged in · Charges from 23:30");

  await d.show(states({ ...plugged, ...val(E.charge_mode, "Timer") }));
  assert.equal(d.line(), "Plugged in · No timers enabled");

  await d.show(states({ ...plugged, ...val(E.charge_mode, "Timer"), [E.clock_synced]: { state: "off", attributes: {} } }));
  assert.equal(d.line(), "Plugged in · Waiting for clock sync");
  assert.equal(d.shown(".warning"), true);

  await d.show(states({ ...plugged, ...val(E.charge_mode, "On"), ...val(E.charger_state, "charge-complete") }));
  assert.equal(d.line(), "Plugged in · Charge complete");
  assert.equal(d.shown(".warning"), false);

  await d.show(states({ ...plugged, ...val(E.charge_mode, "On"), ...val(E.charger_state, "charge-paused") }));
  assert.equal(d.line(), "Plugged in · Charging paused");

  await d.show(states({ ...plugged, ...val(E.charge_mode, "On"), ...val(E.charger_state, "charge-suspended") }));
  assert.equal(d.line(), "Plugged in · Charging suspended");
});

test("tapping the charger opens its charger_state history", async () => {
  const d = await setup();
  await d.show(states());
  let opened = null;
  d.card.addEventListener("hass-more-info", (ev) => { opened = ev.detail.entityId; });
  d.$(".top").click();
  assert.equal(opened, E.charger_state);
});

// ---- Charge mode control & timer strip -------------------------------------

test("charge mode buttons reflect state, show hints, and call select.select_option", async () => {
  const d = await setup();
  await d.show(states());
  assert.equal(d.modeBtn("Off").classList.contains("active"), true);
  assert.equal(d.modeBtn("Off").getAttribute("aria-pressed"), "true");
  assert.equal(d.$(".row.mode .hint").textContent, "The car won't charge, timers included");

  await d.show(states({ ...val(E.charge_mode, "On") }));
  assert.equal(d.modeBtn("On").classList.contains("active"), true);
  assert.equal(d.$(".row.mode .hint").textContent, "Whenever the car's plugged in");

  await d.show(states({
    ...val(E.charge_mode, "Timer"),
    ...on(E.timer_1_enabled),
    ...val(E.timer_1_start, "00:30:00"),
    ...val(E.timer_1_end, "04:30:00"),
  }));
  assert.equal(d.modeBtn("Timer").classList.contains("active"), true);
  assert.equal(d.$(".row.mode .hint").textContent, "00:30–04:30");

  d.modeBtn("On").click();
  d.modeBtn("Off").click();
  assert.deepEqual(d.services, [
    { domain: "select", service: "select_option", data: { option: "On" }, target: { entity_id: E.charge_mode } },
    { domain: "select", service: "select_option", data: { option: "Off" }, target: { entity_id: E.charge_mode } },
  ]);

  await d.show(states({ [E.charge_mode]: { state: "unavailable", attributes: {} } }));
  assert.equal(d.modeBtn("On").disabled, true);
  assert.equal(d.$(".row.mode .hint").textContent, "Waiting for the charger");
});

test("refused mode switch keeps current state", async () => {
  const d = await setup({ refuse: true });
  await d.show(states());
  d.modeBtn("On").click();
  await tick(); await tick();
  assert.equal(d.modeBtn("Off").classList.contains("active"), true);
  assert.equal(d.modeBtn("On").classList.contains("active"), false);
});

test("the day's timers show on a strip in Timer mode, ignoring disabled or start==end timers", async () => {
  const d = await setup({ now: "06:00" });
  await d.show(states({
    ...val(E.charge_mode, "On"),
    ...on(E.timer_1_enabled),
    ...val(E.timer_1_start, "23:30:00"),
    ...val(E.timer_1_end, "05:30:00"),
  }));
  assert.equal(d.shown(".day"), false);

  await d.show(states({
    ...val(E.charge_mode, "Timer"),
    ...on(E.timer_1_enabled, E.timer_2_enabled),
    ...val(E.timer_1_start, "23:30:00"),
    ...val(E.timer_1_end, "05:30:00"),
    // timer_2 is 00:00-00:00 (inactive)
  }));
  assert.equal(d.shown(".day"), true);
  assert.deepEqual(d.spans(), [[97.92, 2.08], [0, 22.92]]);
  assert.equal(parseFloat(d.$(".track .now").style.left), 25);
});

// ---- Timer, Power, and Diagnostics blocks ----------------------------------

test("timer, power, and diagnostics blocks show expected summaries and cards", async () => {
  const d = await setup();
  await d.show(states({
    ...on(E.timer_1_enabled),
    ...val(E.timer_1_start, "00:30:00"),
    ...val(E.timer_1_end, "04:30:00"),
    ...on(E.timer_2_enabled),
    ...val(E.timer_2_start, "00:00:00"),
    ...val(E.timer_2_end, "00:00:00"),
    ...val(E.session_energy, "12.345", "kWh"),
    ...val(E.energy_total, "456.789", "kWh"),
    ...val(E.charger_state, "charging"),
    ...val(E.cpu_temperature, "45.6", "°C"),
    ...val(E.wifi_rssi, "-62", "dBm"),
  }));
  assert.equal(d.summary("timer_1"), "On · 00:30–04:30");
  assert.equal(d.summary("timer_2"), "On · Inactive");
  assert.equal(d.summary("power"), "This session: 12.35 kWh · Total: 456.8 kWh");
  assert.equal(d.summary("diagnostics"), "charging · 46 °C · -62 dBm");

  // Diagnostics is folded by default when there is no saved user data.
  assert.equal(d.block("diagnostics").classList.contains("collapsed"), true);
  assert.equal(d.block("power").classList.contains("collapsed"), false);

  assert.deepEqual(
    plain(d.cards("timer_1")[0].config).entities.map((r) => r.entity),
    [E.timer_1_enabled, E.timer_1_start, E.timer_1_end],
  );
  assert.deepEqual(
    d.cards("power").map((c) => [c.config.type, c.config.entity || null]),
    [["sensor", E.power], ["tile", E.session_energy], ["tile", E.energy_total], ["entities", null]],
  );
  const diagRows = plain(d.cards("diagnostics")[0].config).entities;
  assert.equal(diagRows.length, 16);
  assert.equal(diagRows.at(-1).tap_action.target.entity_id, E.reset_bridge);
});

test("live subscription updates renamed entity ids and stops on disconnect", async () => {
  const d = await setup({ live: true });
  await d.show(states());
  assert.deepEqual(plain(d.live.subscribed), [{ type: "eo_lite/subscribe" }]);
  const renamed = { ...E, power: "sensor.driveway_power", charger_state: "sensor.driveway_state" };
  await d.live.push({ entities: renamed });
  assert.equal(d.cards("power")[0].config.entity, "sensor.driveway_power");
  assert.equal(plain(d.cards("diagnostics")[0].config).entities[0].entity, "sensor.driveway_state");
  d.card.remove();
  await tick();
  assert.equal(d.live.stopped, 1);
});

test("tapping headings folds blocks and saves layout, and unrelated states don't redraw", async () => {
  const d = await setup();
  const s = states();
  await d.show(s);
  const power = d.block("power");
  power.querySelector(".head").click();
  assert.equal(power.classList.contains("collapsed"), true);
  assert.deepEqual(d.saved.at(-1), {
    type: "frontend/set_user_data",
    key: "eo_lite_charger",
    value: { collapsed: ["diagnostics", "power"] },
  });
  d.$(".card-head").click();
  assert.equal(d.$(".card").classList.contains("folded"), true);

  const summaryEl = d.block("timer_1").querySelector(".summary");
  summaryEl.textContent = "untouched";
  await d.show({ ...s, "light.kitchen": { state: "off", attributes: {} } });
  assert.equal(summaryEl.textContent, "untouched");
});

// ---- Adding the dashboard --------------------------------------------------

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

test("an admin's browser adds the Charger dashboard, once, with fallback path", async () => {
  const { hass, calls } = pageHass();
  page({ page: hass });
  await tick(); await tick(); await tick();
  const create = calls.find((c) => c.type === "lovelace/dashboards/create");
  assert.deepEqual([create.url_path, create.title, create.icon, create.show_in_sidebar], ["charger", "Charger", "mdi:ev-station", true]);
  assert.deepEqual(calls.at(-1), { type: "lovelace/config/save", url_path: "charger", config: { strategy: { type: "custom:eo-lite" } } });

  let p = pageHass({ dashboards: [{ url_path: "charger" }], configs: { charger: { views: [] } } });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.equal(p.calls.find((c) => c.type === "lovelace/dashboards/create").url_path, "eo-lite-charger");

  p = pageHass({ admin: false });
  page({ page: p.hass });
  await tick(); await tick();
  assert.deepEqual(p.calls, []);

  p = pageHass({ add: false });
  page({ page: p.hass });
  await tick(); await tick();
  assert.deepEqual(types(p.calls), ["eo_lite/config"]);

  p = pageHass({ fail: "lovelace/dashboards/create" });
  page({ page: p.hass });
  await tick(); await tick(); await tick();
  assert.deepEqual(p.calls.at(-1), { type: "eo_lite/claim_dashboard", release: true, error: "it broke" });
});

// ---- XSS protection --------------------------------------------------------

test("hostile names, states and units are shown as text, never as markup", async () => {
  const X = `"><img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
  const { window } = page();
  const Card = window.customElements.get("eo-lite-charger");
  assert.throws(() => new Card().setConfig({ charger: X, entities: {} }));
  const card = window.document.createElement("eo-lite-charger");
  card.setConfig({ charger: C, entities: E, more: [{ id: X, name: X, icon: X, cards: [] }] });
  window.document.body.appendChild(card);
  const hostile = (state, unit) => ({ state, attributes: { unit_of_measurement: unit, friendly_name: X } });
  card.hass = {
    states: {
      ...states(),
      [E.charger_state]: hostile(X),
      [E.power]: hostile(X, X),
      [E.session_energy]: hostile(X, X),
      [E.energy_total]: hostile(X, X),
      [E.charge_mode]: hostile(X),
    },
    callWS: async () => ({}),
    callService: async () => {},
  };
  await tick(); await tick();
  const root = card.shadowRoot;
  assert.equal(root.querySelectorAll("img, script").length, 0);
  assert.equal(window.pwned, undefined);
  assert.ok(root.textContent.includes("<img"));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`ok   ${name}`); } catch (err) { failed += 1; console.log(`FAIL ${name}\n     ${String(err.stack).split("\n").slice(0, 8).join("\n     ")}`); }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
