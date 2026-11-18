// EO-Lite's Charger dashboard, loaded on every page while EO-Lite is set up
// (which is also how the dashboard gets added: see the end).
//
// A dashboard strategy (`strategy: {type: custom:eo-lite}`) that builds the
// Charger dashboard every time it loads. The integration tells it the
// charger's entity ids and its own (websocket `eo_lite/config`). Also
// defines its card:
//   custom:eo-lite-charger   the charger in one card, like the routines on
//                            the Hue-Lite dashboard: a status card (what the
//                            charger's doing, Allow charging and Only during
//                            timers, and the day's timers on a strip), then
//                            a block for each timer and one for power, each
//                            with a heading that sums it up and folds it away
//
// Which blocks are folded is each person's own. Tapping the "Charger"
// heading folds the whole card away.
//
// The timers are the charger's: openeo publishes entities for each timer it
// has (<n> is its place in the list, from 1), and nothing for timers it
// hasn't. It always keeps at least one: deleting the last puts it back to
// 22:00–06:00 at 16 A. Deleting one moves the later timers up a number.
// EO-Lite finds their entities by openeo's own ids (websocket
// `eo_lite/subscribe`), as Home Assistant may name them after the charger's
// area. For a charger it can't find that way, they're found by name:
//   number.<charger>_charge_schedule_<n>_current
//   time.<charger>_charge_schedule_<n>_start
//   time.<charger>_charge_schedule_<n>_end
//   button.<charger>_delete_charge_schedule_<n>

(() => {
  const DOMAIN = "eo_lite";

  // ---- The dashboard -------------------------------------------------------

  // The Charger view: one card. `setup` is what EO-Lite says (`charger`: the
  // start of the charger's entity ids; `entities`: its entity ids and
  // EO-Lite's).
  function chargerView(setup) {
    const e = setup.entities;
    const card = {
      type: "custom:eo-lite-charger",
      charger: setup.charger,
      entities: e,
      // Blocks after the timers.
      more: [{
        id: "power",
        name: "Power",
        icon: "mdi:lightning-bolt",
        cards: [
          { type: "sensor", entity: e.power, name: "Power now", icon: "mdi:flash", graph: "line", hours_to_show: 24, detail: 2 },
          { type: "tile", entity: e.session_kwh, name: "Energy this session", icon: "mdi:battery-charging" },
          { type: "tile", entity: e.session_cost, name: "Cost this session", icon: "mdi:cash" },
        ],
      }],
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
        // While Home Assistant's starting, EO-Lite may not be set up yet.
        // Home Assistant builds the dashboard again once it's started, by
        // which time it is, so there's no need to wait for it here.
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

  // The round icon, as on the Hue-Lite dashboard's light bars.
  const CIRCLE_CSS = `
    .circle { --mdc-icon-size: 24px; width: 36px; height: 36px; border-radius: 50%; flex: none;
              display: flex; align-items: center; justify-content: center; transition: background-color 180ms, color 180ms;
              background: rgba(var(--rgb-primary-text-color, 33, 33, 33), 0.05); color: var(--state-inactive-color, var(--secondary-text-color)); }`;

  // A focus ring for keyboard use only, not left behind by a tap.
  const FOCUS_CSS = `
    [tabindex]:focus { outline: none; }
    [tabindex]:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }`;

  // Click, Enter or Space (not bubbling up to whatever holds `el`).
  function onActivate(el, fn) {
    el.addEventListener("click", (ev) => { ev.stopPropagation(); fn(); });
    el.addEventListener("keydown", (ev) => {
      if (ev.target === el && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); ev.stopPropagation(); fn(); }
    });
  }

  // Which blocks each person has folded, saved per signed-in user in Home
  // Assistant's frontend storage (so it follows them across devices),
  // falling back to this browser. A list of ids only: anything else (a
  // damaged layout) is dropped.
  async function loadLayout(hass, key) {
    let saved;
    try {
      saved = (await hass.callWS({ type: "frontend/get_user_data", key }))?.value;
    } catch (err) { /* fall through */ }
    if (!saved) {
      try { saved = JSON.parse(localStorage.getItem(key)); } catch (err) { /* none */ }
    }
    const collapsed = Array.isArray(saved?.collapsed) ? saved.collapsed.filter((id) => typeof id === "string") : [];
    return { collapsed };
  }

  function saveLayout(hass, key, layout) {
    try { localStorage.setItem(key, JSON.stringify(layout)); } catch (err) { /* private mode */ }
    hass.callWS({ type: "frontend/set_user_data", key, value: layout }).catch(() => {});
  }

  // Home Assistant's own cards come from its card helpers, loaded once.
  let cardHelpers;
  const loadCardHelpers = () => (cardHelpers = cardHelpers || window.loadCardHelpers());

  // ---- Reading the charger ---------------------------------------------------

  const stateOf = (hass, id) => hass.states[id]?.state;
  const isOn = (hass, id) => stateOf(hass, id) === "on";
  const answering = (hass, id) => ["on", "off"].includes(stateOf(hass, id));
  // An entity's state as a number, or null when it isn't one.
  const number = (hass, id) => {
    const value = Number.parseFloat(stateOf(hass, id));
    return Number.isFinite(value) ? value : null;
  };
  const unitOf = (hass, id) => hass.states[id]?.attributes?.unit_of_measurement || "";
  // A time entity's state as minutes after midnight, or null when it isn't set.
  const minutes = (hass, id) => {
    const match = /^(\d\d):(\d\d)/.exec(stateOf(hass, id) || "");
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
  };
  const clockOf = (mins) => (mins === null ? "--:--" : `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`);
  const kilowatts = (hass, id) => {
    const power = number(hass, id) ?? 0;
    return unitOf(hass, id) === "W" ? power / 1000 : power;
  };
  const CURRENCIES = { GBP: "£", EUR: "€", USD: "$", "£": "£", "€": "€", $: "$" };
  const DAY = 24 * 60;

  // The start of the next timer after `now` (minutes after midnight), or null.
  function nextStart(timers, now) {
    let best = null;
    for (const t of timers) {
      if (t.start === null) continue;
      const wait = (t.start - now + DAY) % DAY;
      if (best === null || wait < best.wait) best = { wait, start: t.start };
    }
    return best?.start ?? null;
  }

  // A timer's window as stretches of the day, as fractions of it: one, or two
  // for a timer that runs past midnight.
  function stretches(t) {
    if (t.start === null || t.end === null || t.start === t.end) return [];
    if (t.start < t.end) return [[t.start / DAY, t.end / DAY]];
    return [[t.start / DAY, 1], [0, t.end / DAY]];
  }

  // ---- Charger card --------------------------------------------------------

  // The status card: what the charger's doing, the two toggles, and the
  // day's timers on a strip. Below it, a block for each timer and the
  // `more` blocks, holding Home Assistant's own cards, like the routines on
  // the Hue-Lite dashboard: each block's summary goes on its own line under
  // its name, so it isn't cut off on a phone.
  //   {charger, entities, more: [{id, name, icon, cards}]}
  // `charger` is the start of the charger's entity ids, for its timers;
  // `entities` are the entity ids.
  const ALL = "all";
  const TITLE = "Charger";

  // How the charger shows: the circle's colour, its icon, and its line.
  const LOOKS = {
    charging: { rgb: "var(--eo-charging-rgb)", icon: "mdi:ev-station" },
    waiting: { rgb: "var(--eo-waiting-rgb)", icon: "mdi:ev-plug-type2" },
    idle: { rgb: null, icon: "mdi:ev-station" },
    away: { rgb: null, icon: "mdi:ev-station" },
  };

  const CARD_CSS = `
    :host { display: block; --eo-charging-rgb: 67, 160, 71; --eo-waiting-rgb: 255, 193, 7; }
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
    /* While charging, a soft ring spreads out from the circle now and then. */
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
    .rows { margin-top: 8px; padding-top: 4px; border-top: 1px solid var(--divider-color); }
    .row { display: flex; align-items: center; gap: 16px; min-height: 52px; padding: 0 4px; }
    .row > ha-icon { flex: none; width: 40px; --mdc-icon-size: 24px; color: var(--state-icon-color, #44739e); }
    .row.on > ha-icon { color: var(--state-switch-active-color, var(--state-active-color, var(--amber-color, #ffc107))); }
    .row .text { flex: 1; min-width: 0; }
    .row .label { font-size: 14px; line-height: 20px; color: var(--primary-text-color); }
    .row .hint { font-size: 12px; line-height: 16px; color: var(--secondary-text-color); }
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
    .body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
    .new { display: flex; flex-direction: column; gap: 8px; }
    .note { padding: 4px; font-size: 14px; color: var(--secondary-text-color); }`;

  class EoLiteCharger extends HTMLElement {
    setConfig(config) {
      if (typeof config?.charger !== "string" || !/^[a-z0-9_]+$/.test(config.charger)) {
        throw new Error("charger is the start of the charger's entity ids, like openeo_charger");
      }
      if (config.more !== undefined && !Array.isArray(config.more)) throw new Error("more must be a list of blocks");
      this._config = config;
      this._charger = config.charger;
      // The charger's entities and timers, kept up to date by EO-Lite once
      // the card's subscribed; until then, from the config, and by name.
      this._entities = { ...(config.entities || {}), ...(this._live?.entities || {}) };
      this._layout = this._layout || { collapsed: [] };
      this._root = this._root || this.attachShadow({ mode: "open" });
      // The blocks by id, and each timer's by its number.
      this._blocks = new Map();
      this._timers = new Map();
      this._addCards = [];
      this._seen = null;
      this._render();
      if (this._hass) this._update();
    }

    set hass(hass) {
      this._hass = hass;
      if (!this._config) return;
      if (!this._loaded) this._load();
      if (this.isConnected) this._subscribe();
      // The cards inside skip redrawing themselves when their own states haven't changed.
      for (const el of [...this._blocks.values(), ...this._timers.values()]) for (const card of el.cards) card.hass = hass;
      for (const card of this._addCards) card.hass = hass;
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

    // EO-Lite says which entities are the charger's timers, now and as
    // they're added and deleted.
    _subscribe() {
      if (this._unsubscribe || !this._hass.connection?.subscribeMessage) return;
      this._unsubscribe = this._hass.connection.subscribeMessage((live) => {
        this._live = live;
        this._entities = { ...(this._config.entities || {}), ...(live.entities || {}) };
        this._seen = null;
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
      this._layoutLoaded = true;
      this._arrange();
    }

    _toggleCollapsed(id) {
      const c = this._layout.collapsed;
      this._layout.collapsed = c.includes(id) ? c.filter((x) => x !== id) : [...c, id];
      saveLayout(this._hass, this._layoutKey, this._layout);
      this._arrange();
    }

    // ---- The timers' entities ----------------------------------------------

    // A timer's entities.
    _ids(n) {
      const live = this._live?.timers?.find((t) => String(t.n) === n);
      if (live) return { current: live.current, start: live.start, end: live.end, remove: live.remove };
      const c = this._charger;
      return {
        current: `number.${c}_charge_schedule_${n}_current`,
        start: `time.${c}_charge_schedule_${n}_start`,
        end: `time.${c}_charge_schedule_${n}_end`,
        remove: `button.${c}_delete_charge_schedule_${n}`,
      };
    }

    // Every timer the charger has, in order.
    _numbers() {
      if (Array.isArray(this._live?.timers)) return this._live.timers.map((t) => String(t.n));
      const start = `number.${this._charger}_charge_schedule_`;
      const end = "_current";
      const found = [];
      for (const id in this._hass.states) {
        if (!id.startsWith(start) || !id.endsWith(end)) continue;
        const n = id.slice(start.length, -end.length);
        if (/^\d+$/.test(n)) found.push(n);
      }
      return found.sort((a, b) => Number(a) - Number(b));
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
              <div class="rows">
                <div class="row allow">
                  <ha-icon icon="mdi:power-plug-battery"></ha-icon>
                  <div class="text"><div class="label">Allow charging</div><div class="hint"></div></div>
                  <ha-switch></ha-switch>
                </div>
                <div class="row timed">
                  <ha-icon icon="mdi:timer-outline"></ha-icon>
                  <div class="text"><div class="label">Only during timers</div><div class="hint"></div></div>
                  <ha-switch></ha-switch>
                </div>
              </div>
              <div class="day" hidden>
                <div class="track"></div>
                <div class="hours"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
              </div>
            </ha-card>
            <div class="new"><div class="note" hidden></div><div class="add" hidden></div></div>
          </div>
        </div>`;
      const $ = (sel) => this._root.querySelector(sel);
      $("h2").textContent = TITLE;
      const head = $(".card-head");
      head.title = `Show or hide the ${TITLE.toLowerCase()}`;
      onActivate(head, () => this._toggleCollapsed(ALL));
      // The charger's own dialog, with its history.
      const top = $(".top");
      top.title = "Show the charger's history";
      onActivate(top, () => this._moreInfo(this._entities.state));
      // The toggles switch EO-Lite's switches, which set the charger.
      for (const [row, key] of [[".allow", "allow_charging"], [".timed", "only_during_timers"]]) {
        const toggle = $(`${row} ha-switch`);
        toggle.addEventListener("change", () => this._switch(this._entities[key], toggle.checked));
      }
      this._el = {
        status: $(".status"), icon: $(".top ha-icon"), name: $(".top .name"), state: $(".top .state"), reading: $(".reading"), value: $(".reading .value"),
        allow: $(".allow"), allowHint: $(".allow .hint"), allowSwitch: $(".allow ha-switch"),
        timed: $(".timed"), timedHint: $(".timed .hint"), timedSwitch: $(".timed ha-switch"),
        day: $(".day"), track: $(".track"), list: $(".blocks"), after: $(".new"), note: $(".note"), add: $(".add"),
      };
      const render = (this._rendering = {});
      for (const b of this._config.more || []) {
        const el = this._block(b.id, b.name, b.icon, b.cards);
        this._blocks.set(b.id, el);
        this._el.list.appendChild(el);
      }
      // New timer: there from the start, shown while the charger's answering.
      this._fill(render, this._el.add, this._addCards, [{
        type: "entities",
        entities: [{
          type: "button",
          name: "New timer",
          icon: "mdi:timer-plus-outline",
          action_name: "Add",
          tap_action: { action: "perform-action", perform_action: "button.press", target: { entity_id: this._entities.add_timer } },
        }],
      }]);
      this._arrange();
    }

    _switch(entityId, on) {
      if (entityId) this._hass.callService("switch", on ? "turn_on" : "turn_off", {}, { entity_id: entityId });
    }

    _moreInfo(entityId) {
      if (entityId) this.dispatchEvent(new CustomEvent("hass-more-info", { detail: { entityId }, bubbles: true, composed: true }));
    }

    // A block: a heading (chevron, icon, name and summary; tapping it opens
    // or closes the block) above its cards.
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

    // A timer's settings: its times and current, and deleting it (`deletable`:
    // `alone` when it's the only one, which the charger puts back to its
    // default rather than deleting).
    _timerCard(n, deletable) {
      const ids = this._ids(n);
      const rows = [
        { entity: ids.start, name: "From", icon: "mdi:clock-start" },
        { entity: ids.end, name: "Until", icon: "mdi:clock-end" },
        { entity: ids.current, name: "Charge current", icon: "mdi:current-ac" },
      ];
      if (deletable) {
        rows.push({
          type: "button",
          name: "Delete this timer",
          icon: "mdi:delete-outline",
          action_name: "Delete",
          tap_action: {
            action: "perform-action",
            perform_action: "button.press",
            target: { entity_id: ids.remove },
            confirmation: {
              text: deletable === "alone"
                ? `Timer ${n} is the only one, so the charger keeps it, back at ${this._defaultText()}. Reset it?`
                : `Delete timer ${n}? The timers after it move up a number.`,
            },
          },
        });
      }
      return { type: "entities", entities: rows };
    }

    _timerBlock(n, deletable) {
      const el = this._block(`timer_${n}`, `Timer ${n}`, "mdi:timer-outline", [this._timerCard(n, deletable)]);
      el.deletable = deletable;
      return el;
    }

    // Fills `into` with Home Assistant cards once its card helpers have
    // loaded, unless the card has been rendered again in the meantime.
    async _fill(render, into, cards, configs) {
      const helpers = await loadCardHelpers();
      if (render !== this._rendering) return;
      for (const config of configs) {
        const card = helpers.createCardElement(config);
        if (this._hass) card.hass = this._hass;
        into.appendChild(card);
        cards.push(card);
      }
    }

    // Applies the folded state: the whole card's, then each block's.
    _arrange() {
      const collapsed = this._layout.collapsed;
      const folded = collapsed.includes(ALL);
      this._root.querySelector(".card").classList.toggle("folded", folded);
      this._root.querySelector(".card-head").setAttribute("aria-expanded", String(!folded));
      for (const el of [...this._blocks.values(), ...this._timers.values()]) {
        const closed = collapsed.includes(el.dataset.id);
        el.classList.toggle("collapsed", closed);
        el.querySelector(".head").setAttribute("aria-expanded", String(!closed));
      }
    }

    // Whether any state the card shows changed since it last looked. Home
    // Assistant hands out a new hass on every state change in the house, but
    // replaces a state object only when that entity changes, so comparing
    // the objects is enough to skip redrawing for everything else. The time
    // counts too, a minute at a time, for the strip's now.
    _changed(numbers) {
      const ids = [...Object.values(this._entities), ...numbers.flatMap((n) => Object.values(this._ids(n)))];
      const states = [...ids.map((id) => this._hass.states[id]), Math.floor(Date.now() / 60000)];
      const changed = !this._seen || states.length !== this._seen.length || states.some((s, i) => s !== this._seen[i]);
      this._seen = states;
      return changed;
    }

    _update() {
      const hass = this._hass;
      const e = this._entities;
      const numbers = this._numbers();
      if (!this._changed(numbers)) return;
      const timers = numbers.map((n) => {
        const ids = this._ids(n);
        return { n, start: minutes(hass, ids.start), end: minutes(hass, ids.end), amps: number(hass, ids.current), unit: unitOf(hass, ids.current) || "A" };
      });
      this._updateTimers(timers);
      this._updateStatus(timers);

      // Each timer's times and current on its heading, and each block's summary.
      for (const t of timers) {
        const amps = t.amps === null ? "–" : Math.round(t.amps * 10) / 10;
        this._timers.get(t.n).querySelector(".summary").textContent = `${clockOf(t.start)}–${clockOf(t.end)} · ${amps} ${t.unit}`;
      }
      const power = this._blocks.get("power");
      if (power) {
        const cost = (number(hass, e.session_cost) ?? 0).toFixed(2);
        const unit = unitOf(hass, e.session_cost);
        const money = CURRENCIES[unit] ? `${CURRENCIES[unit]}${cost}` : `${cost} ${unit}`.trim();
        power.querySelector(".summary").textContent = `This session: ${(number(hass, e.session_kwh) ?? 0).toFixed(2)} kWh · ${money}`;
      }

      // After the timers: New timer while the charger's answering.
      const answers = stateOf(hass, e.add_timer) !== undefined && stateOf(hass, e.add_timer) !== "unavailable";
      this._el.note.textContent = answers ? "" : "The charger isn't answering, so timers can't be added.";
      this._el.note.hidden = answers;
      this._el.add.hidden = !answers;
    }

    // The timer openeo adds, and leaves when the last one's deleted.
    get _default() {
      const d = this._live?.default_timer || { start: "22:00", end: "06:00", amps: 16 };
      const mins = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
      return { start: mins(d.start), end: mins(d.end), amps: d.amps };
    }

    _defaultText() {
      const d = this._default;
      return `${clockOf(d.start)}–${clockOf(d.end)} at ${d.amps} A`;
    }

    // Whether a timer can be deleted: while there are others, and the only
    // one too unless it's just the charger's default (deleting it would
    // change nothing).
    _deletable(t, timers) {
      if (timers.length > 1) return true;
      const d = this._default;
      return t.start === d.start && t.end === d.end && t.amps === d.amps ? false : "alone";
    }

    // A block for each timer. Ones still there stay as they are, so a timer
    // that's being edited isn't disturbed.
    _updateTimers(timers) {
      const numbers = timers.map((t) => t.n);
      let forgot = false;
      for (const [n, el] of this._timers) {
        if (numbers.includes(n)) continue;
        el.remove();
        this._timers.delete(n);
        // Gone, so a timer that takes its number later starts open.
        if (this._layout.collapsed.includes(el.dataset.id)) {
          this._layout.collapsed = this._layout.collapsed.filter((id) => id !== el.dataset.id);
          forgot = true;
        }
      }
      if (forgot && this._layoutLoaded) saveLayout(this._hass, this._layoutKey, this._layout);
      for (const t of timers) {
        const n = t.n;
        if (this._timers.has(n)) continue;
        const el = this._timerBlock(n, this._deletable(t, timers));
        this._timers.set(n, el);
        const next = numbers.find((m) => Number(m) > Number(n) && this._timers.has(m));
        this._el.list.insertBefore(el, next ? this._timers.get(next) : this._el.after);
      }
      // A timer's card is made again when whether it can be deleted changes.
      for (const t of timers) {
        const el = this._timers.get(t.n);
        const deletable = this._deletable(t, timers);
        if (el.deletable === deletable) continue;
        el.deletable = deletable;
        const body = el.querySelector(".body");
        body.replaceChildren();
        el.cards = [];
        this._fill(this._rendering, body, el.cards, [this._timerCard(t.n, deletable)]);
      }
      this._arrange();
    }

    // The status card: what the charger's doing, the toggles, and the strip.
    _updateStatus(timers) {
      const hass = this._hass;
      const e = this._entities;
      const el = this._el;
      const now = new Date();
      const nowMins = now.getHours() * 60 + now.getMinutes();
      const known = answering(hass, e.allow_charging);
      const allow = isOn(hass, e.allow_charging);
      const timed = allow && isOn(hass, e.only_during_timers);
      const reachable = ![e.state, e.charging_active].every((id) => [undefined, "unavailable"].includes(stateOf(hass, id)));
      const charging = isOn(hass, e.charging_active);
      const plugged = isOn(hass, e.vehicle_connected);
      const windows = timers.filter((t) => t.start !== null && t.end !== null).map((t) => `${clockOf(t.start)}–${clockOf(t.end)}`);

      // What it's doing, then a line saying more.
      let look;
      let name;
      let line;
      if (!reachable) {
        [look, name, line] = ["away", "Not answering", "Home Assistant can't reach the charger"];
      } else if (charging) {
        [look, name, line] = ["charging", "Charging", `${(number(hass, e.vehicle_current) ?? 0).toFixed(1)} A · ${(number(hass, e.session_kwh) ?? 0).toFixed(2)} kWh so far`];
      } else if (plugged) {
        const next = nextStart(timers, nowMins);
        line = !allow ? "Charging is off"
          : timed && next !== null ? `Charges from ${clockOf(next)}` : "Not charging";
        [look, name] = ["waiting", "Plugged in"];
      } else {
        [look, name, line] = ["idle", "Ready", "No car plugged in"];
      }
      const { rgb, icon } = LOOKS[look];
      el.status.className = `status ${look}${rgb ? " lit" : ""}${reachable ? "" : " unavailable"}`;
      if (rgb) el.status.style.setProperty("--look-rgb", rgb);
      el.icon.setAttribute("icon", icon);
      el.name.textContent = name;
      el.state.textContent = line;
      el.reading.hidden = !charging;
      el.value.textContent = kilowatts(hass, e.power).toFixed(1);

      // The toggles, and what they mean.
      el.allow.classList.toggle("on", allow);
      el.allowSwitch.checked = allow;
      el.allowSwitch.disabled = !hass.states[e.allow_charging];
      el.allowHint.textContent = !known ? "Waiting for the charger"
        : !allow ? "The car won't charge, timers included"
          : timed ? "Only during the timers" : "Whenever the car's plugged in";
      el.timed.hidden = !allow;
      el.timed.classList.toggle("on", timed);
      el.timedSwitch.checked = timed;
      el.timedHint.textContent = windows.length ? windows.join(" · ") : "No timers";

      // The day's timers, while they're what decides.
      el.day.hidden = !timed || !windows.length;
      el.day.classList.toggle("idle", !timed);
      el.track.replaceChildren(
        ...timers.flatMap(stretches).map(([from, to]) => {
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

  const STRATEGY = "custom:eo-lite";

  // The page's hass, once Home Assistant has it (or null after two minutes).
  async function pageHass() {
    for (let i = 0; i < 120; i++) {
      const hass = document.querySelector("home-assistant")?.hass;
      if (hass?.connection && hass.user) return hass;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  }

  // EO-Lite's Charger dashboard is added the first time an admin opens Home
  // Assistant after setting EO-Lite up (unless its option's off), as
  // Settings → Dashboards → Add would, at /charger; a dashboard of EO-Lite's
  // already there is found instead. EO-Lite remembers, so it's only added
  // once, and only by one browser.
  async function addDashboard() {
    const hass = await pageHass();
    if (!hass?.user.is_admin) return;
    // A page opened while Home Assistant's starting can get here before
    // EO-Lite's set up: keep asking for a while.
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
      // Give the claim back, so the next admin page load tries again, and
      // say why in Home Assistant's log.
      const error = String(err?.message || err?.code || err).slice(0, 300);
      hass.callWS({ type: `${DOMAIN}/claim_dashboard`, release: true, error }).catch(() => {});
    }
  }

  if (!window.eoLiteAddingDashboard) {
    window.eoLiteAddingDashboard = true;
    addDashboard();
  }

  // ---- A dashboard opened before this script arrived ------------------------

  // Home Assistant waits 5 seconds for a dashboard's strategy, then shows
  // "Timeout waiting for strategy element" and doesn't try again (on a slow
  // connection, or with a page opened while Home Assistant was starting).
  // Once this script's here, ask a Charger dashboard showing that to load again.
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
