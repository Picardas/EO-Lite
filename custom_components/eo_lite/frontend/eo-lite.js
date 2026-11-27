// EO-Lite's Charger dashboard, loaded on every page while EO-Lite is set up
// (which is also how the dashboard gets added: see the end).
//
// A dashboard strategy (`strategy: {type: custom:eo-lite}`) that builds the
// Charger dashboard every time it loads. The integration tells it the
// charger's ESPHome entity ids (websocket `eo_lite/config` and
// `eo_lite/subscribe`). Also defines its card:
//   custom:eo-lite-charger   the charger in one card, styled like Hue-Lite:
//                            a status card (what the charger's doing, the 3-way
//                            charge mode control, NTP warning when needed, and
//                            the day's timers on a strip), then collapsible
//                            blocks for Timer 1, Timer 2, Power, and
//                            Diagnostics.
//
// Which blocks are folded is each person's own (Diagnostics starts folded).
// Tapping the "Charger" heading folds the whole card away.

(() => {
  const DOMAIN = "eo_lite";
  const STRATEGY = "custom:eo-lite";
  const MODES = ["Off", "Timer", "On"];
  const DEFAULT_COLLAPSED = ["diagnostics"];

  // ---- The dashboard -------------------------------------------------------

  function chargerView(setup) {
    const card = {
      type: "custom:eo-lite-charger",
      charger: setup.charger,
      entities: setup.entities,
    };
    return {
      title: "Charger",
      path: "charger",
      icon: "mdi:ev-station",
      type: "sections",
      max_columns: 3,
      sections: [{ type: "grid", column_span: 3, cards: [card] }],
    };
  }

  class EoLiteStrategy extends HTMLElement {
    static async generate(config, hass) {
      const setup = await hass.callWS({ type: `${DOMAIN}/config` }).catch(() => null);
      if (!setup) {
        const starting = hass.config?.state !== "RUNNING";
        return {
          views: [{
            title: "Charger",
            cards: [{
              type: "markdown",
              content: starting ? "EO-Lite is starting…" : "EO-Lite isn't set up. Add it in **Settings → Devices & services**.",
            }],
          }],
        };
      }
      return { views: [chargerView(setup)] };
    }
  }

  // ---- Shared card bits ----------------------------------------------------

  const CIRCLE_CSS = `
    .circle { --mdc-icon-size: 24px; width: 36px; height: 36px; border-radius: 50%; flex: none;
              display: flex; align-items: center; justify-content: center; transition: background-color 180ms, color 180ms;
              background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.05); color: var(--state-inactive-color, var(--secondary-text-color)); }`;

  const FOCUS_CSS = `
    [tabindex]:focus { outline: none; }
    [tabindex]:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }`;

  function onActivate(el, fn) {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    el.addEventListener("keydown", (ev) => {
      if (ev.target === el && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); ev.stopPropagation(); fn(); }
    });
  }

  async function loadLayout(hass, key) {
    let saved;
    try {
      saved = (await hass.callWS({ type: "frontend/get_user_data", key }))?.value;
    } catch (err) { /* fall through */ }
    if (!saved) {
      try { saved = JSON.parse(localStorage.getItem(key)); } catch (err) { /* none */ }
    }
    const collapsed = Array.isArray(saved?.collapsed)
      ? saved.collapsed.filter((id) => typeof id === "string")
      : [...DEFAULT_COLLAPSED];
    return { collapsed };
  }

  function saveLayout(hass, key, layout) {
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch (err) { /* private mode */ }
    hass.callWS({ type: "frontend/set_user_data", key, value: layout }).catch(() => {});
  }

  let cardHelpers;
  const loadCardHelpers = () => (cardHelpers = cardHelpers || window.loadCardHelpers());

  // ---- Reading the charger -------------------------------------------------

  const stateOf = (hass, id) => hass.states[id]?.state;
  const isOn = (hass, id) => stateOf(hass, id) === "on";
  const number = (hass, id) => {
    const value = Number.parseFloat(stateOf(hass, id));
    return Number.isFinite(value) ? value : null;
  };
  const unitOf = (hass, id) => hass.states[id]?.attributes?.unit_of_measurement || "";
  const minutes = (hass, id) => {
    const match = /^(\d\d):(\d\d)/.exec(stateOf(hass, id) || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const clockOf = (mins) => (mins === null ? "--:--" : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
  const kilowatts = (hass, id) => {
    const power = number(hass, id) ?? 0;
    return unitOf(hass, id) === "W" ? power / 1000 : power;
  };
  const DAY = 24 * 60;

  function nextStart(timers, now) {
    let best = null;
    for (const t of timers) {
      if (!t.enabled || t.start === null || t.end === null || t.start === t.end) continue;
      const wait = (t.start - now + DAY) % DAY;
      if (best === null || wait < best.wait) best = { wait, start: t.start };
    }
    return best?.start ?? null;
  }

  function stretches(t) {
    if (!t.enabled || t.start === null || t.end === null || t.start === t.end) return [];
    if (t.start < t.end) return [[t.start / DAY, t.end / DAY]];
    return [[t.start / DAY, 1], [0, t.end / DAY]];
  }

  // ---- Charger card --------------------------------------------------------

  const ALL = "all";
  const TITLE = "Charger";

  const LOOKS = {
    charging: { rgb: "var(--eo-charging-rgb)", icon: "mdi:ev-station" },
    waiting: { rgb: "var(--eo-waiting-rgb)", icon: "mdi:ev-plug-type2" },
    fault: { rgb: "var(--eo-fault-rgb)", icon: "mdi:alert-circle-outline" },
    idle: { rgb: null, icon: "mdi:ev-station" },
    away: { rgb: null, icon: "mdi:ev-station" },
  };

  const CARD_CSS = `
    :host { display: block; --eo-charging-rgb: 67, 160, 71; --eo-waiting-rgb: 255, 193, 7; --eo-fault-rgb: 211, 47, 47; }
    ${CIRCLE_CSS}
    ${FOCUS_CSS}
    .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: 16px; align-items: start; }
    .collapsed .body { display: none; }
    .card-head { display: inline-flex; align-items: center; gap: 2px; min-height: 32px; padding: 0 4px; margin-bottom: 8px;
                 cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; border-radius: 8px; }
    h2 { margin: 0; font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
    .card-head .chev { --mdc-icon-size: 20px; }
    .folded .card-head .chev { transform: rotate(-90deg); }
    .folded .blocks { display: none; }
    [hidden] { display: none !important; }

    /* The status card. */
    ha-card.status { display: block; padding: 12px; box-sizing: border-box; }
    .top { display: flex; align-items: center; gap: 12px; min-height: 48px; cursor: pointer; border-radius: 8px;
           -webkit-tap-highlight-color: transparent; }
    .top .circle { width: 44px; height: 44px; --mdc-icon-size: 26px; position: relative; }
    .status.lit .top .circle { background: rgba(var(--look-rgb), 0.2); color: rgb(var(--look-rgb)); }
    .status.charging .top .circle::after { content: ""; position: absolute; inset: 0; border-radius: 50%;
           box-shadow: 0 0 0 0 rgba(var(--look-rgb), 0.4); animation: pulse 2.4s ease-out infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(var(--look-rgb), 0.4); } 70%, 100% { box-shadow: 0 0 0 10px rgba(var(--look-rgb), 0); } }
    @media (prefers-reduced-motion: reduce) { .status.charging .top .circle::after { animation: none; } }
    .status.unavailable .top { opacity: 0.5; }
    .top .text { flex: 1; min-width: 0; }
    .top .name { font-size: 16px; font-weight: 500; line-height: 22px; color: var(--primary-text-color); }
    .top .state { font-size: 13px; line-height: 18px; color: var(--secondary-text-color);
                  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .reading { flex: none; text-align: right; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
    .reading .value { font-size: 24px; font-weight: 400; line-height: 28px; }
    .reading .unit { font-size: 13px; margin-left: 2px; color: var(--secondary-text-color); }
    .status.charging .reading .value { color: rgb(var(--eo-charging-rgb)); }

    .warning { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; padding: 8px 10px; border-radius: 8px;
               background: rgba(var(--eo-waiting-rgb), 0.14); border: 1px solid rgba(var(--eo-waiting-rgb), 0.4);
               color: var(--primary-text-color); font-size: 12px; line-height: 16px; }
    .warning ha-icon { flex: none; --mdc-icon-size: 18px; color: rgb(var(--eo-waiting-rgb)); margin-top: 1px; }

    .rows { margin-top: 8px; padding-top: 4px; border-top: 1px solid var(--divider-color); }
    .row { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 0 4px; }
    .row > ha-icon { flex: none; width: 40px; --mdc-icon-size: 24px; color: var(--state-icon-color, #44739e); }
    .row.on > ha-icon { color: var(--state-switch-active-color, var(--state-active-color, var(--amber-color, #ffc107))); }
    .row .text { flex: 1; min-width: 0; }
    .row .label { font-size: 14px; line-height: 20px; color: var(--primary-text-color); }
    .row .hint { font-size: 12px; line-height: 16px; color: var(--secondary-text-color); }
    .modes { display: inline-flex; flex: none; padding: 2px; border-radius: 8px;
             background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.06); border: 1px solid var(--divider-color); }
    .modes button { appearance: none; border: 0; background: transparent; color: var(--secondary-text-color);
                    font: inherit; font-size: 12px; font-weight: 500; padding: 6px 10px; border-radius: 6px;
                    cursor: pointer; transition: background-color 150ms, color 150ms; }
    .modes button.active { background: var(--primary-color); color: var(--text-primary-color, #fff); }
    .modes button:disabled { opacity: 0.45; cursor: default; }
    .modes button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }

    .day { margin: 4px 4px 0; padding-top: 12px; border-top: 1px solid var(--divider-color); }
    .track { position: relative; height: 8px; border-radius: 4px; background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.08); }
    .span { position: absolute; top: 0; bottom: 0; border-radius: 4px; background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.75); }
    .day.idle .span { background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.25); }
    .now { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--primary-text-color); }
    .hours { display: flex; justify-content: space-between; margin-top: 6px; font-size: 11px; line-height: 14px;
             color: var(--secondary-text-color); font-variant-numeric: tabular-nums; }

    /* The blocks. */
    .head { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 4px; cursor: pointer; user-select: none;
            color: var(--primary-text-color); -webkit-tap-highlight-color: transparent; border-radius: 8px; }
    .block-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); flex: none; }
    .head .text { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 4px 0; }
    .title { font-size: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .summary { font-size: 13px; color: var(--secondary-text-color); }
    .chev { --mdc-icon-size: 22px; color: var(--secondary-text-color); transition: transform 180ms; flex: none; }
    .collapsed .chev { transform: rotate(-90deg); }
    .body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }`;

  class EoLiteCharger extends HTMLElement {
    setConfig(config) {
      if (typeof config?.charger !== "string" || !/^[a-z0-9_]+$/.test(config.charger)) {
        throw new Error("charger is the start of the charger's entity ids, like eo_mini_pro_2");
      }
      if (config.more !== undefined && !Array.isArray(config.more)) throw new Error("more must be a list of blocks");
      this._config = config;
      this._charger = config.charger;
      this._entities = { ...(config.entities || {}), ...(this._live?.entities || {}) };
      this._layout = this._layout || { collapsed: [...DEFAULT_COLLAPSED] };
      this._root = this._root || this.attachShadow({ mode: "open" });
      this._blocks = new Map();
      this._blockSpecs = [];
      this._seen = null;
      this._render();
      if (this._hass) this._update();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._config) return;
      if (!this._loaded) this._load();
      if (this.isConnected) this._subscribe();
      for (const el of this._blocks.values()) for (const card of el.cards) card.hass = hass;
      this._update();
    }

    connectedCallback() {
      if (this._hass && this._config) this._subscribe();
    }

    disconnectedCallback() {
      const unsubscribe = this._unsubscribe;
      this._unsubscribe = null;
      unsubscribe?.then((stop) => stop()).catch(() => {});
    }

    _subscribe() {
      if (this._unsubscribe || !this._hass.connection?.subscribeMessage) return;
      this._unsubscribe = this._hass.connection.subscribeMessage((live) => {
        this._live = live;
        this._entities = { ...(this._config.entities || {}), ...(live.entities || {}) };
        this._seen = null;
        this._syncBlocks();
        this._update();
      }, { type: `${DOMAIN}/subscribe` });
      this._unsubscribe.catch(() => { this._unsubscribe = null; });
    }

    getCardSize() {
      return 8;
    }

    getGridOptions() {
      return { columns: "full", rows: "auto" };
    }

    get _layoutKey() {
      return this._config.layout_key || "eo_lite_charger";
    }

    async _load() {
      this._loaded = true;
      this._layout = await loadLayout(this._hass, this._layoutKey);
      this._arrange();
    }

    _toggleCollapsed(id) {
      const c = this._layout.collapsed;
      this._layout.collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      saveLayout(this._hass, this._layoutKey, this._layout);
      this._arrange();
    }

    // ---- Blocks built from Oureo's entities --------------------------------

    _desiredBlocks() {
      const e = this._entities;
      const timerCards = (n) => [{
        type: "entities",
        entities: [
          { entity: e[`timer_${n}_enabled`], name: "Enabled", icon: "mdi:timer-outline" },
          { entity: e[`timer_${n}_start`], name: "From", icon: "mdi:clock-start" },
          { entity: e[`timer_${n}_end`], name: "Until", icon: "mdi:clock-end" },
        ],
      }];
      return [
        { id: "timer_1", name: "Timer 1", icon: "mdi:timer-outline", cards: timerCards(1) },
        { id: "timer_2", name: "Timer 2", icon: "mdi:timer-outline", cards: timerCards(2) },
        {
          id: "power",
          name: "Power",
          icon: "mdi:lightning-bolt",
          cards: [
            { type: "sensor", entity: e.power, name: "Power now", icon: "mdi:flash", graph: "line", hours_to_show: 24, detail: 2 },
            { type: "tile", entity: e.session_energy, name: "Energy this session", icon: "mdi:battery-charging" },
            { type: "tile", entity: e.energy_total, name: "Total energy", icon: "mdi:counter" },
            {
              type: "entities",
              entities: [
                { entity: e.current, name: "Current", icon: "mdi:current-ac" },
                { entity: e.voltage, name: "Voltage", icon: "mdi:sine-wave" },
                { entity: e.frequency, name: "Frequency", icon: "mdi:waveform" },
              ],
            },
          ],
        },
        {
          id: "diagnostics",
          name: "Diagnostics",
          icon: "mdi:wrench-outline",
          cards: [{
            type: "entities",
            entities: [
              { entity: e.charger_state, name: "Charger state", icon: "mdi:ev-station" },
              { entity: e.cable_connected, name: "Cable connected", icon: "mdi:cable-data" },
              { entity: e.vehicle_connected, name: "Vehicle connected", icon: "mdi:car-electric" },
              { entity: e.charging_active, name: "Charging active", icon: "mdi:battery-charging" },
              { entity: e.mains_fault, name: "Mains fault", icon: "mdi:alert-circle-outline" },
              { entity: e.controller_connected, name: "Controller connected", icon: "mdi:lan-connect" },
              { entity: e.clock_synced, name: "Clock synced", icon: "mdi:clock-check-outline" },
              { entity: e.hw_max_current, name: "Hardware max current", icon: "mdi:current-ac" },
              { entity: e.cpu_temperature, name: "CPU temperature", icon: "mdi:thermometer" },
              { entity: e.wifi_rssi, name: "Wi-Fi signal", icon: "mdi:wifi" },
              { entity: e.rs485_errors, name: "RS-485 errors", icon: "mdi:alert-outline" },
              { entity: e.eo_firmware_version, name: "Firmware version", icon: "mdi:chip" },
              { entity: e.watchdog_timeout, name: "Watchdog timeout", icon: "mdi:timer-sand" },
              { entity: e.watchdog_current, name: "Watchdog current", icon: "mdi:current-ac" },
              { entity: e.mains_voltage_correction, name: "Mains voltage correction", icon: "mdi:tune" },
              {
                type: "button",
                name: "Reset RS-485 bridge",
                icon: "mdi:restart",
                action_name: "Reset",
                tap_action: {
                  action: "perform-action",
                  perform_action: "button.press",
                  target: { entity_id: e.reset_bridge },
                  confirmation: { text: "Hard-reset the RS-485 bridge?" },
                },
              },
            ],
          }],
        },
        ...(this._config.more || []),
      ];
    }

    _syncBlocks() {
      const specs = this._desiredBlocks();
      const orderChanged = specs.length !== this._blockSpecs.length || specs.some((s, i) => s.id !== this._blockSpecs[i]?.id);
      if (orderChanged) {
        for (const el of this._blocks.values()) el.remove();
        this._blocks.clear();
        for (const b of specs) {
          const el = this._block(b.id, b.name, b.icon, b.cards);
          el.cardsKey = JSON.stringify(b.cards);
          this._blocks.set(b.id, el);
          this._el.list.appendChild(el);
        }
      } else {
        for (const b of specs) {
          const el = this._blocks.get(b.id);
          const cardsKey = JSON.stringify(b.cards);
          if (el.cardsKey === cardsKey) continue;
          el.cardsKey = cardsKey;
          const body = el.querySelector(".body");
          body.replaceChildren();
          el.cards = [];
          this._fill(this._rendering, body, el.cards, b.cards);
        }
      }
      this._blockSpecs = specs;
      this._arrange();
    }

    // ---- Rendering ---------------------------------------------------------

    _render() {
      this._root.innerHTML = `
        <style>${CARD_CSS}</style>
        <div class="card">
          <div class="card-head" role="button" tabindex="0">
            <h2></h2><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
          </div>
          <div class="blocks">
            <ha-card class="status">
              <div class="top" role="button" tabindex="0">
                <div class="circle"><ha-icon></ha-icon></div>
                <div class="text"><div class="name"></div><div class="state"></div></div>
                <div class="reading" hidden><span class="value"></span><span class="unit">kW</span></div>
              </div>
              <div class="warning" hidden>
                <ha-icon icon="mdi:clock-alert-outline"></ha-icon>
                <span>Charger clock not synced — Timer charging is paused until NTP sync completes.</span>
              </div>
              <div class="rows">
                <div class="row mode">
                  <ha-icon icon="mdi:power-plug-battery"></ha-icon>
                  <div class="text"><div class="label">Charge mode</div><div class="hint"></div></div>
                  <div class="modes" role="group" aria-label="Charge mode"></div>
                </div>
              </div>
              <div class="day" hidden>
                <div class="track"></div>
                <div class="hours"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
              </div>
            </ha-card>
          </div>
        </div>`;
      const $ = (sel) => this._root.querySelector(sel);
      $("h2").textContent = TITLE;
      const head = $(".card-head");
      head.title = `Show or hide the ${TITLE.toLowerCase()}`;
      onActivate(head, () => this._toggleCollapsed(ALL));
      const top = $(".top");
      top.title = "Show the charger's history";
      onActivate(top, () => this._moreInfo(this._entities.charger_state));

      const modes = $(".modes");
      const modeButtons = {};
      for (const option of MODES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = option;
        btn.dataset.mode = option;
        btn.addEventListener("click", () => this._selectMode(option));
        modes.appendChild(btn);
        modeButtons[option] = btn;
      }

      this._el = {
        status: $(".status"), icon: $(".top ha-icon"), name: $(".top .name"), state: $(".top .state"),
        reading: $(".reading"), value: $(".reading .value"), warning: $(".warning"),
        modeRow: $(".row.mode"), modeHint: $(".row.mode .hint"), modeButtons,
        day: $(".day"), track: $(".track"), list: $(".blocks"),
      };
      this._rendering = {};
      this._blocks.clear();
      this._blockSpecs = [];
      this._syncBlocks();
    }

    _selectMode(option) {
      const entityId = this._entities.charge_mode;
      if (!entityId) return;
      this._hass.callService("select", "select_option", { option }, { entity_id: entityId })
        .catch(() => { this._seen = null; this._update(); });
    }

    _moreInfo(entityId) {
      if (entityId) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
    }

    _block(id, name, icon, cards) {
      const el = document.createElement("div");
      el.className = "block";
      el.dataset.id = id;
      el.cards = [];
      el.innerHTML = `
        <div class="head" role="button" tabindex="0">
          <ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
          <ha-icon class="block-icon"></ha-icon>
          <span class="text"><span class="title"></span><span class="summary"></span></span>
        </div>
        <div class="body"></div>`;
      el.querySelector(".title").textContent = name;
      el.querySelector(".block-icon").setAttribute("icon", icon);
      onActivate(el.querySelector(".head"), () => this._toggleCollapsed(id));
      this._fill(this._rendering, el.querySelector(".body"), el.cards, cards);
      return el;
    }

    async _fill(render, into, cards, configs) {
      const fill = (into.fill = {});
      const helpers = await loadCardHelpers();
      if (render !== this._rendering || into.fill !== fill) return;
      for (const config of configs) {
        const card = helpers.createCardElement(config);
        if (this._hass) card.hass = this._hass;
        into.appendChild(card);
        cards.push(card);
      }
    }

    _arrange() {
      const collapsed = this._layout.collapsed;
      const folded = collapsed.includes(ALL);
      this._root.querySelector(".card").classList.toggle("folded", folded);
      this._root.querySelector(".card-head").setAttribute("aria-expanded", String(!folded));
      for (const el of this._blocks.values()) {
        const closed = collapsed.includes(el.dataset.id);
        el.classList.toggle("collapsed", closed);
        el.querySelector(".head").setAttribute("aria-expanded", String(!closed));
      }
    }

    _changed() {
      const ids = Object.values(this._entities);
      const states = [...ids.map((id) => this._hass.states[id]), Math.floor(Date.now() / 60000)];
      const changed = !this._seen || states.length !== this._seen.length || states.some((s, i) => s !== this._seen[i]);
      this._seen = states;
      return changed;
    }

    _timer(n) {
      const hass = this._hass;
      const e = this._entities;
      return {
        n,
        enabled: isOn(hass, e[`timer_${n}_enabled`]),
        start: minutes(hass, e[`timer_${n}_start`]),
        end: minutes(hass, e[`timer_${n}_end`]),
      };
    }

    _update() {
      const hass = this._hass;
      const e = this._entities;
      if (!this._changed()) return;
      const timers = [this._timer(1), this._timer(2)];
      this._updateStatus(timers);

      for (const t of timers) {
        const block = this._blocks.get(`timer_${t.n}`);
        if (!block) continue;
        let summary;
        if (t.enabled) {
          summary = t.start !== null && t.end !== null && t.start === t.end
            ? "On · Inactive"
            : `On · ${clockOf(t.start)}–${clockOf(t.end)}`;
        } else {
          summary = t.start !== null && t.end !== null && t.start !== t.end
            ? `Off · ${clockOf(t.start)}–${clockOf(t.end)}`
            : "Off";
        }
        block.querySelector(".summary").textContent = summary;
      }

      const power = this._blocks.get("power");
      if (power) {
        const session = (number(hass, e.session_energy) ?? 0).toFixed(2);
        const total = (number(hass, e.energy_total) ?? 0).toFixed(1);
        power.querySelector(".summary").textContent = `This session: ${session} kWh · Total: ${total} kWh`;
      }

      const diag = this._blocks.get("diagnostics");
      if (diag) {
        let summary;
        if (stateOf(hass, e.controller_connected) === "off") {
          summary = "Controller offline";
        } else {
          const parts = [];
          const chargerState = stateOf(hass, e.charger_state);
          if (chargerState && chargerState !== "unavailable" && chargerState !== "unknown") parts.push(chargerState);
          const cpu = number(hass, e.cpu_temperature);
          if (cpu !== null) parts.push(`${Math.round(cpu)} °C`);
          const rssi = number(hass, e.wifi_rssi);
          if (rssi !== null) parts.push(`${Math.round(rssi)} dBm`);
          summary = parts.length ? parts.join(" · ") : "–";
        }
        diag.querySelector(".summary").textContent = summary;
      }
    }

    _updateStatus(timers) {
      const hass = this._hass;
      const e = this._entities;
      const el = this._el;
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();

      const mode = stateOf(hass, e.charge_mode);
      const knownMode = MODES.includes(mode);
      const chargerState = stateOf(hass, e.charger_state);
      const controllerOff = stateOf(hass, e.controller_connected) === "off";
      const missing = [e.charger_state, e.charging_active].every((id) => [undefined, "unavailable"].includes(stateOf(hass, id)));
      const offline = controllerOff || missing;
      const fault = !offline && (isOn(hass, e.mains_fault) || ["mains-fault", "mains-fault-start"].includes(chargerState));
      const charging = !offline && !fault && isOn(hass, e.charging_active);
      const plugged = !offline && !fault && isOn(hass, e.vehicle_connected);
      const cable = !offline && !fault && isOn(hass, e.cable_connected);
      const clockOff = stateOf(hass, e.clock_synced) === "off";

      let look;
      let name;
      let line;
      if (controllerOff) {
        [look, name, line] = ["away", "Not answering", "RS-485 link to power board lost"];
      } else if (missing) {
        [look, name, line] = ["away", "Not answering", "Home Assistant can't reach the charger"];
      } else if (fault) {
        [look, name, line] = ["fault", "Mains fault", "Charging halted — check incoming mains"];
      } else if (charging) {
        [look, name, line] = ["charging", "Charging", `${(number(hass, e.current) ?? 0).toFixed(1)} A · ${(number(hass, e.session_energy) ?? 0).toFixed(2)} kWh so far`];
      } else if (plugged) {
        [look, name] = ["waiting", "Plugged in"];
        if (mode === "Off") {
          line = "Charging is off";
        } else if (mode === "Timer") {
          const next = nextStart(timers, nowMins);
          line = clockOff ? "Waiting for clock sync" : next !== null ? `Charges from ${clockOf(next)}` : "No timers enabled";
        } else if (["charge-complete", "charge-complete-start"].includes(chargerState)) {
          line = "Charge complete";
        } else if (chargerState === "charge-paused") {
          line = "Charging paused";
        } else if (["charge-suspended", "charge-suspended-start"].includes(chargerState)) {
          line = "Charging suspended";
        } else {
          line = "Not charging";
        }
      } else if (cable) {
        [look, name, line] = ["waiting", "Cable connected", "No vehicle connected"];
      } else {
        [look, name, line] = ["idle", "Ready", "No car plugged in"];
      }

      const { rgb, icon } = LOOKS[look];
      el.status.className = `status ${look}${rgb ? " lit" : ""}${offline ? " unavailable" : ""}`;
      if (rgb) el.status.style.setProperty("--look-rgb", rgb);
      else el.status.style.removeProperty("--look-rgb");
      el.icon.setAttribute("icon", icon);
      el.name.textContent = name;
      el.state.textContent = line;
      el.reading.hidden = !charging;
      el.value.textContent = kilowatts(hass, e.power).toFixed(1);

      el.warning.hidden = !(mode === "Timer" && clockOff);

      const activeTimers = timers.filter((t) => t.enabled && t.start !== null && t.end !== null && t.start !== t.end);
      const windows = activeTimers.map((t) => `${clockOf(t.start)}–${clockOf(t.end)}`);

      el.modeRow.classList.toggle("on", mode === "On" || mode === "Timer");
      el.modeHint.textContent = !knownMode ? "Waiting for the charger"
        : mode === "Off" ? "The car won't charge, timers included"
          : mode === "On" ? "Whenever the car's plugged in"
            : windows.length ? windows.join(" · ") : "No timers enabled";

      const modeDisabled = !hass.states[e.charge_mode] || mode === "unavailable";
      for (const option of MODES) {
        const btn = el.modeButtons[option];
        btn.classList.toggle("active", mode === option);
        btn.setAttribute("aria-pressed", String(mode === option));
        btn.disabled = modeDisabled;
      }

      el.day.hidden = mode !== "Timer" || !activeTimers.length;
      el.day.classList.toggle("idle", mode !== "Timer");
      el.track.replaceChildren(
        ...activeTimers.flatMap(stretches).map(([from, to]) => {
          const span = document.createElement("div");
          span.className = "span";
          span.style.left = `${(from * 100).toFixed(2)}%`;
          span.style.width = `${((to - from) * 100).toFixed(2)}%`;
          return span;
        }),
        Object.assign(document.createElement("div"), { className: "now", style: `left: ${((nowMins / DAY) * 100).toFixed(2)}%` }),
      );
    }
  }

  for (const [tag, cls] of [
    ["ll-strategy-dashboard-eo-lite", EoLiteStrategy],
    ["eo-lite-charger", EoLiteCharger],
  ]) {
    if (!customElements.get(tag)) customElements.define(tag, cls);
  }

  // ---- Adding the dashboard ------------------------------------------------

  async function pageHass() {
    for (let i = 0; i < 120; i++) {
      const hass = document.querySelector("home-assistant")?.hass;
      if (hass?.connection && hass.user) return hass;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  async function addDashboard() {
    const hass = await pageHass();
    if (!hass?.user.is_admin) return;
    let setup = null;
    for (let i = 0; i < 20 && !setup; i++) {
      setup = await hass.callWS({ type: `${DOMAIN}/config` }).catch(() => null);
      if (!setup) await new Promise((r) => setTimeout(r, 15000));
    }
    if (!setup?.add_dashboard) return;
    const { claimed } = await hass.callWS({ type: `${DOMAIN}/claim_dashboard` }).catch(() => ({}));
    if (!claimed) return;
    try {
      const dashboards = await hass.callWS({ type: "lovelace/dashboards/list" });
      for (const d of dashboards) {
        const config = await hass.callWS({ type: "lovelace/config", url_path: d.url_path }).catch(() => null);
        if (config?.strategy?.type === STRATEGY) return;
      }
      const taken = dashboards.some((d) => d.url_path === "charger") || hass.panels?.charger;
      const urlPath = taken ? "eo-lite-charger" : "charger";
      await hass.callWS({
        type: "lovelace/dashboards/create", url_path: urlPath, allow_single_word: true, mode: "storage",
        title: "Charger", icon: "mdi:ev-station", show_in_sidebar: true, require_admin: false,
      });
      await hass.callWS({ type: "lovelace/config/save", url_path: urlPath, config: { strategy: { type: STRATEGY } } });
    } catch (err) {
      const error = String(err?.message || err?.code || err).slice(0, 300);
      hass.callWS({ type: `${DOMAIN}/claim_dashboard`, release: true, error }).catch(() => {});
    }
  }

  if (!window.eoLiteAddingDashboard) {
    window.eoLiteAddingDashboard = true;
    addDashboard();
  }

  function retryTimedOut() {
    const main = document.querySelector("home-assistant")?.shadowRoot?.querySelector("home-assistant-main");
    const panel = main?.shadowRoot?.querySelector("ha-panel-lovelace");
    const lovelace = panel?.lovelace;
    if (lovelace?.rawConfig?.strategy?.type !== STRATEGY) return;
    if (!JSON.stringify(lovelace.config?.views ?? []).includes("Timeout waiting for strategy element")) return;
    panel.shadowRoot?.querySelector("hui-root")?.dispatchEvent(new CustomEvent("config-refresh", { bubbles: true, composed: true }));
  }

  retryTimedOut();
  window.addEventListener("location-changed", () => setTimeout(retryTimedOut, 0));
})();
