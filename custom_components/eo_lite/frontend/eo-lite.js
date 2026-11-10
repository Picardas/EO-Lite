// EO-Lite's Charger dashboard, loaded on every page while EO-Lite is set up
// (which is also how the dashboard gets added: see the end).
//
// A dashboard strategy (`strategy: {type: custom:eo-lite}`) that builds the
// Charger dashboard every time it loads. The integration tells it the
// charger's entity ids and its own (websocket `eo_lite/config`). Also
// defines its card:
//   custom:eo-lite-charger   the charger as blocks that fold away, like the
//                            routines on the Hue-Lite dashboard: each with a
//                            heading (its name, and a line summing it up)
//                            over Home Assistant's own cards
//
// Layout: one card, Charger, whose heading folds it all away. Its blocks:
// Now (what the charger's doing), When to charge (Allow charging, and Only
// during timers under it while that's on), a block for each of the charger's
// timers with New timer after them, and Power (this session's energy and
// cost). Which blocks are folded is each person's own.
//
// The timers are the charger integration's, as many as it has slots for,
// found by their entities (<n> is the slot's number):
//   number.<charger>_charge_schedule_<n>_current   above 0: the timer's in use
//   time.<charger>_charge_schedule_<n>_start
//   time.<charger>_charge_schedule_<n>_end
//   button.<charger>_delete_charge_schedule_<n>
//   button.<charger>_add_charge_schedule           takes the next free slot

(() => {
  const DOMAIN = "eo_lite";

  // ---- The dashboard -------------------------------------------------------

  function whenOn(toggle, row) {
    return { type: "conditional", conditions: [{ entity: toggle, state: "on" }], row };
  }

  // The Charger view: one card of blocks. `setup` is what EO-Lite says
  // (`charger`: the start of the charger's entity ids; `entities`: its
  // entity ids and EO-Lite's).
  function chargerView(setup) {
    const e = setup.entities;
    const card = {
      type: "custom:eo-lite-charger",
      charger: setup.charger,
      entities: e,
      blocks: [{
        id: "now",
        name: "Now",
        icon: "mdi:ev-station",
        cards: [
          { type: "tile", entity: e.state, name: "Charger", icon: "mdi:ev-plug-type2", state_content: ["state", "last_changed"] },
        ],
      }, {
        id: "when",
        name: "When to charge",
        icon: "mdi:calendar-clock",
        cards: [{
          type: "entities",
          entities: [
            { entity: e.allow_charging, name: "Allow charging" },
            whenOn(e.allow_charging, { entity: e.only_during_timers, name: "Only during timers" }),
          ],
        }],
      }],
      // After the timers.
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

  // ---- Summaries -----------------------------------------------------------

  const isOn = (hass, id) => hass.states[id]?.state === "on";
  // An entity's state as a number, or null when it isn't one.
  const number = (hass, id) => {
    const value = Number.parseFloat(hass.states[id]?.state);
    return Number.isFinite(value) ? value : null;
  };
  const unitOf = (hass, id) => hass.states[id]?.attributes?.unit_of_measurement || "";
  // A time entity's state as hours and minutes.
  const clock = (hass, id) => {
    const state = hass.states[id]?.state || "";
    return /^\d\d:\d\d/.test(state) ? state.slice(0, 5) : "--:--";
  };
  const CURRENCIES = { GBP: "£", EUR: "€", USD: "$", "£": "£", "€": "€", $: "$" };

  // The line under each block's name. `e` are the entity ids; `timers` the
  // times of the timers in use.
  const SUMMARIES = {
    now: (hass, e) => {
      if (isOn(hass, e.charging_active)) {
        const power = number(hass, e.power) ?? 0;
        const kw = unitOf(hass, e.power) === "W" ? power / 1000 : power;
        return `Charging at ${kw.toFixed(1)} kW · ${(number(hass, e.vehicle_current) ?? 0).toFixed(1)} A`;
      }
      return isOn(hass, e.vehicle_connected) ? "Car plugged in · not charging" : "No car plugged in";
    },
    when: (hass, e, timers) => {
      if (!["on", "off"].includes(hass.states[e.allow_charging]?.state)) return "Waiting for the charger";
      if (!isOn(hass, e.allow_charging)) return "Off";
      if (!isOn(hass, e.only_during_timers)) return "Whenever the car's plugged in";
      return timers.length ? `Only ${timers.join(" · ")}` : "Only during timers: none yet";
    },
    power: (hass, e) => {
      const cost = (number(hass, e.session_cost) ?? 0).toFixed(2);
      const unit = unitOf(hass, e.session_cost);
      const money = CURRENCIES[unit] ? `${CURRENCIES[unit]}${cost}` : `${cost} ${unit}`.trim();
      return `This session: ${(number(hass, e.session_kwh) ?? 0).toFixed(2)} kWh · ${money}`;
    },
  };

  // ---- Charger card --------------------------------------------------------

  // The charger as blocks holding Home Assistant's own cards (entities,
  // tile, sensor), like the routines on the Hue-Lite dashboard. Each block's
  // summary goes on its own line under its name, so it isn't cut off on a
  // phone. Tapping the "Charger" heading folds the whole card away.
  //   {charger, entities, blocks: [{id, name, icon, cards}], more: [the same]}
  // `charger` is the start of the charger's entity ids, for its timers, which
  // go between `blocks` and `more`; `entities` are the entity ids, for the
  // summaries.
  const ALL = "all";
  const TITLE = "Charger";

  class EoLiteCharger extends HTMLElement {
    setConfig(config) {
      if (!Array.isArray(config?.blocks)) throw new Error("blocks is required");
      if (typeof config.charger !== "string" || !/^[a-z0-9_]+$/.test(config.charger)) {
        throw new Error("charger is the start of the charger's entity ids, like openeo_charger");
      }
      this._config = config;
      this._charger = config.charger;
      this._entities = config.entities || {};
      this._layout = this._layout || { collapsed: [] };
      this._root = this._root || this.attachShadow({ mode: "open" });
      // The blocks by id, and each timer's by its slot.
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
      // The cards inside skip redrawing themselves when their own states haven't changed.
      for (const el of [...this._blocks.values(), ...this._timers.values()]) for (const card of el.cards) card.hass = hass;
      for (const card of this._addCards) card.hass = hass;
      this._update();
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

    // A slot's entities.
    _ids(n) {
      const c = this._charger;
      return {
        current: `number.${c}_charge_schedule_${n}_current`,
        start: `time.${c}_charge_schedule_${n}_start`,
        end: `time.${c}_charge_schedule_${n}_end`,
        remove: `button.${c}_delete_charge_schedule_${n}`,
      };
    }

    // Every slot the charger's integration has, in order.
    _slots() {
      const start = `number.${this._charger}_charge_schedule_`;
      const end = "_current";
      const slots = [];
      for (const id in this._hass.states) {
        if (!id.startsWith(start) || !id.endsWith(end)) continue;
        const n = id.slice(start.length, -end.length);
        if (/^\d+$/.test(n)) slots.push(n);
      }
      return slots.sort((a, b) => Number(a) - Number(b));
    }

    // Whether the charger's answering for a slot.
    _reachable(n) {
      const state = this._hass.states[this._ids(n).current]?.state;
      return state !== undefined && state !== "unavailable";
    }

    // ---- Rendering ---------------------------------------------------------

    _render() {
      this._root.innerHTML = `
        <style>
          :host { display: block; }
          .blocks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: 16px; align-items: start; }
          .collapsed .body { display: none; }
          ${FOCUS_CSS}
          .card-head { display: inline-flex; align-items: center; gap: 2px; min-height: 32px; padding: 0 4px; margin-bottom: 8px;
                       cursor: pointer; user-select: none; -webkit-tap-highlight-color: transparent; border-radius: 8px; }
          h2 { margin: 0; font-size: 16px; font-weight: 500; color: var(--primary-text-color); }
          .card-head .chev { --mdc-icon-size: 20px; }
          .folded .card-head .chev { transform: rotate(-90deg); }
          .folded .blocks { display: none; }
          .head { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 0 4px; cursor: pointer; user-select: none;
                  color: var(--primary-text-color); -webkit-tap-highlight-color: transparent; border-radius: 8px; }
          .block-icon { --mdc-icon-size: 20px; color: var(--secondary-text-color); flex: none; }
          .text { flex: 1; min-width: 0; display: flex; flex-direction: column; padding: 4px 0; }
          .title { font-size: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
          .summary { font-size: 13px; color: var(--secondary-text-color); }
          .chev { --mdc-icon-size: 22px; color: var(--secondary-text-color); transition: transform 180ms; flex: none; }
          .collapsed .chev { transform: rotate(-90deg); }
          .body { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
          .new { display: flex; flex-direction: column; gap: 8px; }
          .note { padding: 4px; font-size: 14px; color: var(--secondary-text-color); }
          [hidden] { display: none !important; }
        </style>
        <div class="card">
          <div class="card-head" role="button" tabindex="0">
            <h2></h2><ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>
          </div>
          <div class="blocks"><div class="new"><div class="note" hidden></div><div class="add" hidden></div></div></div>
        </div>`;
      this._root.querySelector("h2").textContent = TITLE;
      const head = this._root.querySelector(".card-head");
      head.title = `Show or hide the ${TITLE.toLowerCase()}`;
      onActivate(head, () => this._toggleCollapsed(ALL));
      const render = (this._rendering = {});
      // The blocks before the timers, the timers (added as they're found)
      // with New timer after them, then the rest.
      const list = this._root.querySelector(".blocks");
      const after = this._root.querySelector(".new");
      for (const [blocks, before] of [[this._config.blocks, after], [this._config.more || [], null]]) {
        for (const b of blocks) {
          const el = this._block(b.id, b.name, b.icon, b.cards);
          this._blocks.set(b.id, el);
          list.insertBefore(el, before);
        }
      }
      // New timer: there from the start, shown while a slot is free.
      this._fill(render, this._root.querySelector(".add"), this._addCards, [{
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

    // A timer's block: its times and current, and deleting it.
    _timerBlock(n) {
      const ids = this._ids(n);
      return this._block(`timer_${n}`, `Timer ${n}`, "mdi:timer-outline", [{
        type: "entities",
        entities: [
          { entity: ids.start, name: "From", icon: "mdi:clock-start" },
          { entity: ids.end, name: "Until", icon: "mdi:clock-end" },
          { entity: ids.current, name: "Charge current", icon: "mdi:current-ac" },
          {
            type: "button",
            name: "Delete this timer",
            icon: "mdi:delete-outline",
            action_name: "Delete",
            tap_action: {
              action: "perform-action",
              perform_action: "button.press",
              target: { entity_id: ids.remove },
              confirmation: { text: `Delete timer ${n}?` },
            },
          },
        ],
      }]);
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
    // the objects is enough to skip redrawing for everything else.
    _changed(slots) {
      const ids = [...Object.values(this._entities), ...slots.flatMap((n) => Object.values(this._ids(n)))];
      const states = ids.map((id) => this._hass.states[id]);
      const changed = !this._seen || states.length !== this._seen.length || states.some((s, i) => s !== this._seen[i]);
      this._seen = states;
      return changed;
    }

    _update() {
      const hass = this._hass;
      const slots = this._slots();
      if (!this._changed(slots)) return;
      const used = slots.filter((n) => number(hass, this._ids(n).current) > 0);

      // A block for each timer in use. The others stay as they are, so
      // adding or deleting a timer doesn't disturb one that's being edited.
      const list = this._root.querySelector(".blocks");
      const after = this._root.querySelector(".new");
      let forgot = false;
      for (const [n, el] of this._timers) {
        if (used.includes(n)) continue;
        el.remove();
        this._timers.delete(n);
        // A deleted timer's slot starts open for the next timer in it (but
        // stays as it was through the charger being unreachable).
        if (this._reachable(n) && this._layout.collapsed.includes(el.dataset.id)) {
          this._layout.collapsed = this._layout.collapsed.filter((id) => id !== el.dataset.id);
          forgot = true;
        }
      }
      if (forgot && this._layoutLoaded) saveLayout(hass, this._layoutKey, this._layout);
      for (const n of used) {
        if (this._timers.has(n)) continue;
        const el = this._timerBlock(n);
        this._timers.set(n, el);
        const next = used.find((m) => Number(m) > Number(n) && this._timers.has(m));
        list.insertBefore(el, next ? this._timers.get(next) : after);
      }
      this._arrange();

      // Each timer's times and current on its heading, and each block's summary.
      const times = [];
      for (const n of used) {
        const ids = this._ids(n);
        const time = `${clock(hass, ids.start)}–${clock(hass, ids.end)}`;
        times.push(time);
        const amps = Math.round(number(hass, ids.current) * 10) / 10;
        this._timers.get(n).querySelector(".summary").textContent = `${time} · ${amps} ${unitOf(hass, ids.current) || "A"}`;
      }
      for (const [id, el] of this._blocks) {
        el.querySelector(".summary").textContent = SUMMARIES[id]?.(hass, this._entities, times) || "";
      }

      // After the timers: New timer while a slot's free, or why there isn't one.
      const reachable = slots.filter((n) => this._reachable(n));
      const free = reachable.length - used.length;
      const note = this._root.querySelector(".note");
      note.textContent = !slots.length ? "The charger has no timers."
        : !reachable.length ? "The charger isn't answering."
          : !free ? `All ${slots.length} timers are in use. Delete one to add another.`
            : !used.length ? "No timers yet." : "";
      note.hidden = !note.textContent;
      this._root.querySelector(".add").hidden = free < 1;
      after.hidden = note.hidden && free < 1;
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
