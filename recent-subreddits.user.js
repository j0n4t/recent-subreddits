// ==UserScript==
// @name         Recent Subreddits Sidebar
// @namespace    https://github.com/your-username/recent-subreddits
// @version      1.2.0
// @description  Adds a popup menu (triggered by hovering/clicking the Reddit logo) listing recently accessed subreddits with pinning support
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      reddit.com
// @run-at       document-idle
// ==/UserScript==
//
// NOTE: this file is not imported — scripts/build.mjs prepends it verbatim to
// the bundle. The metadata block has to be the first thing in the built file,
// so it cannot live in app.js.
(() => {
  // src/hotkey.js
  function parseHotkey(str) {
    const parts = String(str).split("+").map((p) => p.trim()).filter(Boolean);
    const combo = { ctrl: false, alt: false, shift: false, meta: false, key: null };
    for (const part of parts) {
      const p = part.toLowerCase();
      if (p === "ctrl" || p === "control") combo.ctrl = true;
      else if (p === "alt" || p === "option") combo.alt = true;
      else if (p === "shift") combo.shift = true;
      else if (p === "meta" || p === "cmd" || p === "command" || p === "super") combo.meta = true;
      else combo.key = p;
    }
    return combo.key ? combo : null;
  }
  function hotkeyMatches(event, combo) {
    if (!combo) return false;
    if (event.ctrlKey !== combo.ctrl) return false;
    if (event.altKey !== combo.alt) return false;
    if (event.shiftKey !== combo.shift) return false;
    if (event.metaKey !== combo.meta) return false;
    return String(event.key).toLowerCase() === combo.key;
  }
  function comboFromEvent(event) {
    const key = event.key;
    if (["Control", "Alt", "Shift", "Meta"].includes(key)) return null;
    const parts = [];
    if (event.ctrlKey) parts.push("Ctrl");
    if (event.altKey) parts.push("Alt");
    if (event.shiftKey) parts.push("Shift");
    if (event.metaKey) parts.push("Meta");
    const label = key.length === 1 ? key.toUpperCase() : key;
    parts.push(label);
    return parts.join("+");
  }

  // src/defaults.js
  var TRIGGER_SELECTOR = [
    'a[href="/"]',
    // Reddit logo link
    "#header-logo",
    // Old Reddit logo
    ".header-logo",
    // Alternative logo class
    '[data-testid="top-nav-logo"]',
    // New Reddit logo
    'button[aria-label*="menu" i]',
    // Menu button
    "#TopNav button",
    // Top nav button area
    "#reddit-logo",
    "#navbar-menu-button"
  ].join(", ");
  var BUILTIN_HOOK = {
    selector: TRIGGER_SELECTOR,
    mode: "hook",
    events: "both"
  };

  // src/storage.js
  var STORAGE_KEY = "recentSubreddits";
  var MAX_RECENT = 15;
  function loadData() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return { recent: [], pinned: [] };
      const parsed = JSON.parse(raw);
      const data = {
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : []
      };
      return pruneRecent(data, loadSettings().maxRecent);
    } catch {
      return { recent: [], pinned: [] };
    }
  }
  function saveData(data) {
    GM_setValue(STORAGE_KEY, JSON.stringify(data));
  }
  var MIN_MAX_RECENT = 1;
  var MAX_MAX_RECENT = 200;
  function pruneRecent(data, maxRecent) {
    const pinned = new Set(data.pinned);
    const kept = [];
    let unpinned = 0;
    for (const entry of data.recent) {
      if (pinned.has(entry.name)) {
        kept.push(entry);
        continue;
      }
      if (unpinned >= maxRecent) continue;
      kept.push(entry);
      unpinned++;
    }
    data.recent = kept;
    return data;
  }
  var ICONS_KEY = "recentSubredditsIcons";
  var MAX_ICONS = 200;
  function loadIcons() {
    try {
      const raw = GM_getValue(ICONS_KEY, null);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out = {};
      for (const [name, url] of Object.entries(parsed)) {
        if (typeof name === "string" && name && typeof url === "string" && url) out[name] = url;
      }
      return out;
    } catch {
      return {};
    }
  }
  function saveIcons(icons) {
    try {
      const entries = Object.entries(icons);
      const trimmed = entries.length > MAX_ICONS ? entries.slice(-MAX_ICONS) : entries;
      GM_setValue(ICONS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
    } catch {
    }
  }
  var SETTINGS_KEY = "recentSubredditsSettings";
  var DEFAULT_SETTINGS = {
    hotkey: "Alt+Shift+R",
    targets: [BUILTIN_HOOK],
    blocked: [],
    // Opt-in: a tidy list by default, with each row's pin/trash (and the panel's
    // close button) appearing only while its row is hovered.
    hideRowControls: false,
    // Opt-out: show relative timestamps by default; uncheck to hide them.
    showTimestamps: true,
    // How many visited subreddits history keeps. The list is trimmed to this on
    // every visit, so lowering it also prunes what is already stored.
    maxRecent: MAX_RECENT
  };
  function defaultSettings() {
    return {
      ...DEFAULT_SETTINGS,
      targets: DEFAULT_SETTINGS.targets.map((t) => ({ ...t })),
      blocked: []
    };
  }
  var TARGET_MODES = ["hook", "replace", "prepend", "append"];
  var TARGET_EVENTS = ["hover", "click", "both"];
  var hookTargetsCache = null;
  function normalizeTargets(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
      if (!t || typeof t.selector !== "string" || !t.selector.trim()) continue;
      const entry = {
        selector: t.selector.trim(),
        mode: TARGET_MODES.includes(t.mode) ? t.mode : "hook",
        events: TARGET_EVENTS.includes(t.events) ? t.events : "both"
      };
      if (t.size && typeof t.size === "object") {
        if (typeof t.size.width === "string") entry.size = { ...entry.size, width: t.size.width };
        if (typeof t.size.maxHeight === "string") entry.size = { ...entry.size, maxHeight: t.size.maxHeight };
      }
      out.push(entry);
    }
    return out;
  }
  function normalizeBlocked(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const name of raw) {
      if (typeof name !== "string") continue;
      const n = name.trim().toLowerCase();
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }
  function clampMaxRecent(raw) {
    let n;
    if (typeof raw === "number") n = raw;
    else if (typeof raw === "string" && raw.trim()) n = Number(raw);
    else return DEFAULT_SETTINGS.maxRecent;
    if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxRecent;
    const int = Math.floor(n);
    if (int < MIN_MAX_RECENT) return MIN_MAX_RECENT;
    if (int > MAX_MAX_RECENT) return MAX_MAX_RECENT;
    return int;
  }
  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) {
        const seeded = defaultSettings();
        saveSettings(seeded);
        return seeded;
      }
      const parsed = JSON.parse(raw);
      return {
        hotkey: typeof parsed.hotkey === "string" && parsed.hotkey.trim() ? parsed.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
        targets: normalizeTargets(parsed.targets),
        blocked: normalizeBlocked(parsed.blocked),
        // Strict boolean: anything else (a hand-edited "true" string, a null)
        // falls back to the default rather than becoming truthy by accident.
        hideRowControls: parsed.hideRowControls === true,
        showTimestamps: parsed.showTimestamps !== false,
        maxRecent: clampMaxRecent(parsed.maxRecent)
      };
    } catch {
      return defaultSettings();
    }
  }
  function saveSettings(settings) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    hookTargetsCache = null;
  }
  function hookTargets() {
    if (!hookTargetsCache) {
      hookTargetsCache = loadSettings().targets.filter((t) => t.mode === "hook");
    }
    return hookTargetsCache;
  }

  // src/diagnostics.js
  var warned = /* @__PURE__ */ new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[recent-subreddits] ${message}`);
  }
  function countMatches(selector) {
    try {
      return document.querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  }
  function checkTriggers(hookSelectors = []) {
    if (!hookSelectors.length) return;
    if (hookSelectors.some((s) => countMatches(s) > 0)) return;
    warnOnce(
      "triggers",
      `none of the configured hooks matched on this page (selectors: ${hookSelectors.join(", ")}). Hovering or clicking will not open the popup. Use the hotkey instead, and check the Page targets in settings \u2014 Reddit may have changed its markup.`
    );
  }
  function checkHarvest(signals) {
    if (!signals || !signals.named || signals.hasIcon) return;
    warnOnce(
      "harvest",
      `this page names a subreddit but has no #subreddit-icon-img anchor, so its icon cannot be harvested. Icons will fall back to /r/<name>/about.json, which reddit rate-limits \u2014 expect grey placeholders. Reddit may have changed its markup.`
    );
  }

  // src/styles.js
  function injectStyles() {
    if (document.getElementById("rs-styles")) return;
    const style = document.createElement("style");
    style.id = "rs-styles";
    style.textContent = `
    /* Popup container \u2014 hidden by default */
    .recent-subreddits-popup {
      --rs-bg: var(--color-tone-4, #f6f7f8);
      --rs-border: var(--color-tone-5, #e4e6e8);
      --rs-text: var(--color-tone-1, #1c1c1c);
      --rs-text-muted: var(--color-tone-3, #7c7c7c);
      --rs-shadow: rgba(0,0,0,0.15);
      --rs-accent: #d93a00;
      --rs-accent-soft: rgba(217,58,0,0.25);
      --rs-ok: #1a7f37;
      --rs-error: #c9252d;

      display: none;
      position: fixed;
      width: 280px;
      /* Total width, so it matches POPUP_WIDTH in position.js \u2014 the clamp on the
         right edge is computed from that constant. */
      box-sizing: border-box;
      /* NO max-height here: position.js sets it per placement, from the room
         below or above the trigger. A fixed 70vh knew nothing about where the
         popup started, so a trigger low on the page produced a popup running
         off the bottom of the viewport. */
      overflow-y: auto;
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 8px;
      padding: 14px;
      font-size: 13px;
      box-shadow: 0 4px 16px var(--rs-shadow);
      z-index: 10000;
    }
    .recent-subreddits-popup.visible {
      display: block;
      animation: rs-fadein 0.12s ease-out;
    }
    @keyframes rs-fadein {
      from { opacity: 0; transform: translateY(-4px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* Dark mode adaptation */
    @media (prefers-color-scheme: dark) {
      .recent-subreddits-popup {
        --rs-bg: #1a1a1b;
        --rs-border: #343536;
        --rs-text: #d7dadc;
        --rs-text-muted: #818384;
        --rs-shadow: rgba(0,0,0,0.4);
        --rs-ok: #4ac26b;
        --rs-error: #ff7b72;
      }
    }
    /* Reddit dark mode class detection */
    body.theme-dark .recent-subreddits-popup,
    html[data-theme="dark"] .recent-subreddits-popup,
    .dark-mode .recent-subreddits-popup {
      --rs-bg: #1a1a1b;
      --rs-border: #343536;
      --rs-text: #d7dadc;
      --rs-text-muted: #818384;
      --rs-shadow: rgba(0,0,0,0.4);
      --rs-ok: #4ac26b;
      --rs-error: #ff7b72;
    }

    .rs-header-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 8px 0;
    }
    .rs-header {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--rs-text);
    }
    .rs-back-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      line-height: 1;
      color: var(--rs-text-muted);
      display: none;
      transition: color 0.15s;
    }
    /* ---- Shared instance chrome ---- */
    /* The popup and the inline blocks are the same UI in two containers, so
       the view-swap rules key off a shared class rather than the popup's. */
    .rs-instance.settings-open .rs-content { display: none; }
    .rs-instance.settings-open .rs-settings-panel { display: block; }
    .rs-instance.settings-open .rs-back-btn { display: block; }
    /* The gear is redundant next to the "\u2699 Settings" title; back is the way out. */
    .rs-instance.settings-open .rs-settings-btn { display: none; }

    .rs-settings-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 13px;
      line-height: 1;
      opacity: 0.6;
      color: var(--rs-text);
      transition: opacity 0.15s, transform 0.2s;
    }
    .rs-settings-btn:hover { opacity: 1; transform: rotate(30deg); }

    /* ---- Settings modal ---- */
    /* Hidden by default; .settings-open on the instance swaps content for it. */
    .rs-settings-panel { display: none; }

    .rs-field { margin-bottom: 10px; }
    .rs-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--rs-text-muted);
      margin-bottom: 4px;
    }
    .rs-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-size: 13px;
      font-family: inherit;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-input:focus {
      outline: none;
      border-color: var(--rs-accent);
      box-shadow: 0 0 0 2px var(--rs-accent-soft);
    }
    /* The blocklist is one name per line, so it needs a textarea rather than the
       single-line input the other fields use. */
    .rs-blocked-input {
      display: block;
      resize: vertical;
      min-height: 56px;
      font-family: monospace;
      line-height: 1.5;
    }
    /* A numeric field is not clickable-to-edit the way the hotkey field is. */
    .rs-number-input {
      cursor: text;
      width: 80px;
    }
    .rs-hint {
      font-size: 11px;
      color: var(--rs-text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }
    /* A checkbox setting reads as one row: box, then label. */
    .rs-check {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--rs-text);
      cursor: pointer;
    }
    .rs-checkbox {
      margin: 0;
      cursor: pointer;
      accent-color: var(--rs-accent);
    }
    /* ---- Accordion sections ---- */
    .rs-acc-section { border-top: 1px solid var(--rs-border); }
    .rs-acc-section:first-child { border-top: none; }
    .rs-acc-header {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--rs-text-muted);
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;
    }
    .rs-acc-header::after {
      content: '\u25BE';
      font-size: 10px;
      transition: transform 0.15s;
    }
    .rs-acc-section.rs-acc-open .rs-acc-header::after { transform: rotate(180deg); }
    .rs-acc-header:hover { color: var(--rs-text); }
    .rs-acc-body { display: none; padding-bottom: 8px; }
    .rs-acc-section.rs-acc-open .rs-acc-body { display: block; }
    .rs-status {
      font-size: 11px;
      min-height: 14px;
      margin-bottom: 4px;
    }
    .rs-status-ok { color: var(--rs-ok); }
    .rs-status-error { color: var(--rs-error); }
    /* A standing condition rather than a transient message: e.g. no hook is
       configured, so the popup is hotkey-only. */
    .rs-warn {
      margin-top: 6px;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--rs-text);
      background: var(--rs-accent-soft);
      border-radius: 4px;
    }

    /* ---- Page targets ---- */
    .rs-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .rs-label-row .rs-label { margin-bottom: 0; }
    .rs-btn-small {
      padding: 3px 8px;
      font-size: 11px;
    }
    .rs-targets {
      list-style: none;
      margin: 8px 0 0 0;
      padding: 0;
    }
    .rs-target {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 0;
      border-top: 1px solid var(--rs-border);
    }
    .rs-target:first-child { border-top: none; }
    .rs-target-sel {
      font-family: monospace;
      font-size: 11px;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 3px;
      padding: 2px 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rs-target-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .rs-select {
      flex: 1;
      min-width: 0;
      padding: 3px 4px;
      font-size: 11px;
      font-family: inherit;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-select:focus {
      outline: none;
      border-color: var(--rs-accent);
    }
    .rs-muted {
      flex: 1;
      font-size: 11px;
      color: var(--rs-text-muted);
      text-align: center;
    }
    .rs-icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 12px;
      line-height: 1;
      color: var(--rs-text-muted);
    }
    .rs-icon-btn:hover { color: var(--rs-error); }
    .rs-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      /* Pinned to the bottom of the popup's scrollport. The panel is ~590px of
         content, so on a short viewport it scrolls \u2014 and Done is the way out of
         the panel, so it must not be the thing that scrolls out of reach. The
         background is required: without it the fields scroll visibly behind. */
      position: sticky;
      bottom: 0;
      background: var(--rs-bg);
      padding-top: 8px;
      margin-top: 4px;
    }
    .rs-btn {
      display: flex;
      align-items: center;
      padding: 5px 10px;
      font-size: 12px;
      font-family: inherit;
      color: var(--rs-text);
      background: none;
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-btn:hover { border-color: var(--rs-text-muted); }
    .rs-btn-primary {
      background: var(--rs-accent);
      border-color: var(--rs-accent);
      color: #fff;
      font-weight: 600;
    }
    .rs-btn-primary:hover { opacity: 0.9; }
    .rs-section { margin-bottom: 8px; }
    .rs-section:last-child { margin-bottom: 0; }
    .rs-section-title {
      font-weight: 600;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--rs-text-muted);
      margin-bottom: 4px;
    }
    .rs-list {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .rs-item {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      margin: 0;
    }
    .rs-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      object-fit: cover;
      flex-shrink: 0;
      background: var(--rs-border);
      margin: 0;
    }
    .rs-link {
      flex: 1;
      color: var(--rs-text);
      text-decoration: none;
      font-weight: 500;
    }
    .rs-link:hover { text-decoration: underline; }
    .rs-time {
      font-size: 11px;
      color: var(--rs-text-muted);
    }
    .rs-pin-btn, .rs-unpin-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px;
      font-size: 12px;
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .rs-pin-btn:hover, .rs-unpin-btn:hover { opacity: 1; }
    .rs-reorder-up, .rs-reorder-down {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px;
      font-size: 10px;
      line-height: 1;
      color: var(--rs-text-muted);
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .rs-reorder-up:hover, .rs-reorder-down:hover { opacity: 1; }
    .rs-reorder-up:disabled, .rs-reorder-down:disabled {
      opacity: 0.15;
      cursor: default;
    }
    /* The trash sits next to the pin and matches it, so a row's controls read as
       one group. Recent rows only \u2014 the Pinned section uses the \u2715 above. */
    .rs-remove-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px;
      font-size: 12px;
      /* Two things are load-bearing here, both verified by rendering the variants
         side by side on a dark background:
         - the colour must be SET. The pin gets away with inheriting because it is
           an emoji and renders in its own colours, but the trash is a monochrome
           glyph, so unset it inherits whatever the host page uses.
         - it must be the full text colour, not the muted token: as a thin outline
           glyph the muted one measured as borderline/invisible against a dark
           background. The VS16 emoji variant (which would match the pin's weight)
           is not an option \u2014 it renders as tofu on Windows.
         Hover turns it red, so the destructive action is explicit. */
      color: var(--rs-text);
      transition: color 0.15s;
    }
    .rs-remove-btn:hover { color: var(--rs-error); }
    /* ---- Opt-in: controls appear on row hover ---- */
    /* "Hide row controls" in settings puts .rs-hide-controls on the instance.
       The controls keep their place in the row (no reflow on hover) and only
       their visibility changes. Scoped to the instance class rather than the
       controls themselves, so the default look is untouched. */
    .rs-hide-controls .rs-pin-btn,
    .rs-hide-controls .rs-unpin-btn,
    .rs-hide-controls .rs-remove-btn,
    .rs-hide-controls .rs-reorder-up,
    .rs-hide-controls .rs-reorder-down {
      opacity: 0;
    }
    .rs-hide-controls .rs-item:hover .rs-pin-btn,
    .rs-hide-controls .rs-item:hover .rs-unpin-btn,
    .rs-hide-controls .rs-item:hover .rs-remove-btn,
    .rs-hide-controls .rs-item:hover .rs-reorder-up,
    .rs-hide-controls .rs-item:hover .rs-reorder-down,
    .rs-hide-controls .rs-pin-btn:focus-visible,
    .rs-hide-controls .rs-unpin-btn:focus-visible,
    .rs-hide-controls .rs-remove-btn:focus-visible,
    .rs-hide-controls .rs-reorder-up:focus-visible,
    .rs-hide-controls .rs-reorder-down:focus-visible {
      opacity: 1;
    }
    /* The main close button follows the same rule, revealed by hovering the
       header row it sits in. */
    .rs-hide-controls .rs-close-btn {
      opacity: 0;
      transition: color 0.15s, opacity 0.15s;
    }
    .rs-hide-controls .rs-header-row:hover .rs-close-btn,
    .rs-hide-controls .rs-close-btn:focus-visible {
      opacity: 1;
    }
    .rs-empty {
      color: var(--rs-text-muted);
      font-style: italic;
      padding: 8px 0;
    }
    /* ---- Inline instances (replace / prepend / append) ---- */
    /* Same UI as the popup, but in the page flow with no border or shadow.
       The design tokens live on .recent-subreddits-popup, so the inline block
       re-declares them here \u2014 otherwise every var() resolves to nothing and
       the text renders on a transparent background. */
    .rs-inline {
      --rs-bg: var(--color-tone-4, #f6f7f8);
      --rs-border: var(--color-tone-5, #e4e6e8);
      --rs-text: var(--color-tone-1, #1c1c1c);
      --rs-text-muted: var(--color-tone-3, #7c7c7c);
      --rs-shadow: rgba(0,0,0,0.15);
      --rs-accent: #d93a00;
      --rs-accent-soft: rgba(217,58,0,0.25);
      --rs-ok: #1a7f37;
      --rs-error: #c9252d;

      display: block;
      position: static;
      width: auto;
      max-height: none;
      overflow: visible;
      /* Opaque, not transparent: the block is nested inside the element it
         replaces, and anything of that element still painted underneath would
         otherwise show through the list. */
      background: var(--rs-bg);
      border: none;
      border-radius: 0;
      padding: 6px;
      box-shadow: none;
      z-index: auto;
      font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      .rs-inline {
        --rs-bg: #1a1a1b;
        --rs-border: #343536;
        --rs-text: #d7dadc;
        --rs-text-muted: #818384;
        --rs-shadow: rgba(0,0,0,0.4);
        --rs-ok: #4ac26b;
        --rs-error: #ff7b72;
      }
    }
    body.theme-dark .rs-inline,
    html[data-theme="dark"] .rs-inline,
    .dark-mode .rs-inline {
      --rs-bg: #1a1a1b;
      --rs-border: #343536;
      --rs-text: #d7dadc;
      --rs-text-muted: #818384;
      --rs-shadow: rgba(0,0,0,0.4);
      --rs-ok: #4ac26b;
      --rs-error: #ff7b72;
    }
    .rs-inline-host { display: block; position: relative; }
    .rs-inline-host-replace {
      position: absolute;
      visibility: visible;
      top: 0;
      left: 0;
    }
    /* A replace target is marked with this class. visibility:hidden alone is
       not enough: it inherits, but an explicit visibility:visible on a
       DESCENDANT overrides it, and Reddit ships exactly that (a Tailwind
       "visible" class) on its login prompt \u2014 so the prompt stayed painted over
       the replacement block. Force the whole subtree hidden, then re-show our
       own block, which lives inside that subtree. */
    /* .rs-replacing * is load-bearing: !important on the ELEMENT alone does not
       beat the descendant's own visibility:visible, but a rule that matches the
       descendant does. Verified against the fixture and live reddit. */
    .rs-replacing,
    .rs-replacing * {
      visibility: hidden !important;
    }
    /* Both rules are !important, so specificity decides: this selector is more
       specific than the hide rule above, which is what re-shows our block. */
    .rs-replacing > .rs-inline-host,
    .rs-replacing > .rs-inline-host * {
      visibility: visible !important;
    }

    /* ---- Resize handle for inline blocks ---- */
    .rs-resize-handle {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 10px;
      height: 10px;
      cursor: se-resize;
      opacity: 0.25;
      transition: opacity 0.15s;
      /* Hardcoded grey \u2014 visible on both light and dark backgrounds.
         CSS vars don't inherit from sibling to child, so --rs-text-muted
         is undefined here. */
      background:
        linear-gradient(135deg, transparent 0%, transparent 42%, #888 42%, #888 58%, transparent 58%),
        linear-gradient(135deg, transparent 0%, transparent 62%, #888 62%, #888 78%, transparent 78%);
      z-index: 1;
    }
    .rs-resize-handle:hover { opacity: 0.7; }

    /* The close button's role here is to drop the binding. */
    .rs-close-btn {
      margin-left: auto;
      background: none;
      border: none;
      cursor: pointer;
      font-size: 14px;
      color: var(--rs-text-muted);
      padding: 2px 4px;
      line-height: 1;
    }
    .rs-close-btn:hover { color: var(--rs-text); }
  `;
    document.head.appendChild(style);
  }

  // src/visits.js
  function getSubredditFromUrl() {
    const path = window.location.pathname;
    const match = path.match(/^\/r\/([^/]+)/i);
    if (match) {
      const name = match[1];
      return name.toLowerCase();
    }
    return null;
  }
  function isBlocked(name) {
    return loadSettings().blocked.includes(String(name).toLowerCase());
  }
  function trackVisit(name) {
    if (isBlocked(name)) return;
    const data = loadData();
    data.recent = data.recent.filter((s) => s.name !== name);
    data.recent.unshift({
      name,
      visitedAt: Date.now()
    });
    pruneRecent(data, loadSettings().maxRecent);
    saveData(data);
  }
  function togglePin(name, refresh) {
    const data = loadData();
    const pinIndex = data.pinned.indexOf(name);
    if (pinIndex >= 0) {
      data.pinned.splice(pinIndex, 1);
    } else {
      data.pinned.unshift(name);
    }
    saveData(data);
    refresh(data);
  }
  function movePinned(name, direction, refresh) {
    const data = loadData();
    const idx = data.pinned.indexOf(name);
    if (idx < 0) return;
    const swap = direction === "up" ? idx - 1 : idx + 1;
    if (swap < 0 || swap >= data.pinned.length) return;
    [data.pinned[idx], data.pinned[swap]] = [data.pinned[swap], data.pinned[idx]];
    saveData(data);
    refresh(data);
  }
  function removeVisit(name, refresh) {
    const key = String(name).toLowerCase();
    const data = loadData();
    data.recent = data.recent.filter((s2) => s2.name !== key);
    saveData(data);
    const s = loadSettings();
    if (!s.blocked.includes(key)) {
      s.blocked.push(key);
      saveSettings(s);
    }
    refresh(data);
  }

  // src/icons.js
  var DEFAULT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";
  var ICON_MAX_ATTEMPTS = 3;
  var ICON_RETRY_DELAYS = [800, 2e3];
  var ICON_REQUEST_GAP = 120;
  var ICON_FAILURE_RESET = 5 * 6e4;
  var ICON_HOST = /^https:\/\/[a-z0-9.-]*\.?redditmedia\.com\//i;
  var iconCache = loadIcons();
  var iconFailures = {};
  var iconUrlOwner = {};
  var iconQueue = [];
  var iconInFlight = /* @__PURE__ */ new Set();
  var iconPumpRunning = false;
  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  function cachedIcon(name) {
    return iconCache[name] || DEFAULT_ICON;
  }
  function readCurrentSubredditIcon() {
    const el = document.getElementById("subreddit-icon-img");
    if (!el) return null;
    const img = el.tagName === "IMG" ? el : el.querySelector("img");
    let src = img ? img.getAttribute("src") : null;
    if (!src) {
      const carrier = el.querySelector('[style*="background-image"]') || el;
      const style = carrier.getAttribute && carrier.getAttribute("style");
      const bg = style ? /url\(["']?(.*?)["']?\)/.exec(style) : null;
      if (bg) src = bg[1];
    }
    if (!src || !ICON_HOST.test(src)) return null;
    return src;
  }
  function currentSubredditName() {
    const header = document.querySelector("shreddit-subreddit-header[name]");
    if (!header) return null;
    const name = (header.getAttribute("name") || "").trim().toLowerCase();
    return name || null;
  }
  function recordIcon(name, icon, isMounted) {
    iconCache[name] = icon;
    iconUrlOwner[icon] = name;
    delete iconFailures[name];
    saveIcons(iconCache);
    updateIconInDom(name, icon, isMounted);
  }
  function harvestSignals() {
    return { named: !!currentSubredditName(), hasIcon: !!readCurrentSubredditIcon() };
  }
  function harvestCurrentSubredditIcon(isMounted) {
    const icon = readCurrentSubredditIcon();
    if (!icon) return false;
    const name = currentSubredditName();
    if (!name) return false;
    const owner = iconUrlOwner[icon];
    if (owner && owner !== name) return false;
    if (iconCache[name] === icon) return false;
    recordIcon(name, icon, isMounted);
    return true;
  }
  function updateIconInDom(name, icon, isMounted) {
    if (!isMounted() || !icon) return;
    const encoded = encodeURIComponent(name);
    const icons = document.querySelectorAll("img.rs-icon");
    icons.forEach((img) => {
      if (img.dataset.name === encoded) img.src = icon;
    });
  }
  function recordFailure(name, isMounted) {
    const prev = iconFailures[name];
    const attempts = (prev ? prev.attempts : 0) + 1;
    const delay = ICON_RETRY_DELAYS[attempts - 1] ?? ICON_RETRY_DELAYS[ICON_RETRY_DELAYS.length - 1];
    iconFailures[name] = {
      attempts,
      nextTryAt: Date.now() + delay,
      firstFailedAt: prev ? prev.firstFailedAt : Date.now()
    };
    if (attempts < ICON_MAX_ATTEMPTS) {
      setTimeout(() => queueIcon(name, isMounted), delay);
    }
  }
  function shouldQueue(name) {
    if (iconCache[name]) return false;
    if (iconInFlight.has(name)) return false;
    if (iconQueue.includes(name)) return false;
    const f = iconFailures[name];
    if (!f) return true;
    if (f.attempts >= ICON_MAX_ATTEMPTS) {
      if (Date.now() - f.firstFailedAt < ICON_FAILURE_RESET) return false;
      delete iconFailures[name];
      return true;
    }
    return Date.now() >= f.nextTryAt;
  }
  function requestIcon(name, isMounted) {
    iconInFlight.add(name);
    GM_xmlhttpRequest({
      method: "GET",
      url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
      headers: { Accept: "application/json" },
      onload(res) {
        iconInFlight.delete(name);
        let icon = "";
        if (res.status === 200) {
          try {
            const data = JSON.parse(res.responseText);
            icon = data.data?.icon_img || data.data?.community_icon || "";
          } catch {
          }
          icon = icon.replace(/&amp;/g, "&");
        }
        if (icon) {
          recordIcon(name, icon, isMounted);
          return;
        }
        recordFailure(name, isMounted);
      },
      onerror() {
        iconInFlight.delete(name);
        recordFailure(name, isMounted);
      }
    });
  }
  function pumpIconQueue(isMounted) {
    if (iconPumpRunning) return;
    const next = iconQueue.shift();
    if (!next) return;
    iconPumpRunning = true;
    requestIcon(next, isMounted);
    setTimeout(() => {
      iconPumpRunning = false;
      pumpIconQueue(isMounted);
    }, ICON_REQUEST_GAP);
  }
  function queueIcon(name, isMounted) {
    if (!shouldQueue(name)) return;
    iconQueue.push(name);
    pumpIconQueue(isMounted);
  }
  function fetchSubredditIcon(name, isMounted) {
    queueIcon(name, isMounted);
    return cachedIcon(name);
  }

  // src/position.js
  var POPUP_WIDTH = 280;
  var GAP = 8;
  var MARGIN = 16;
  var MIN_HEIGHT = 120;
  function viewportRoom() {
    return window.innerHeight - MARGIN * 2;
  }
  function roomAround(rect) {
    return {
      below: window.innerHeight - MARGIN - (rect.bottom + GAP),
      above: rect.top - GAP - MARGIN
    };
  }
  function capAndMeasure(popup, maxHeight) {
    popup.style.maxHeight = Math.max(MIN_HEIGHT, Math.round(maxHeight)) + "px";
    return popup.offsetHeight;
  }
  function positionPopup(popup, trigger) {
    const rect = trigger.getBoundingClientRect();
    const room = roomAround(rect);
    const natural = capAndMeasure(popup, viewportRoom());
    let below;
    if (room.below >= natural) below = true;
    else if (room.above >= natural) below = false;
    else below = room.below >= room.above;
    const side = below ? room.below : room.above;
    const height = capAndMeasure(popup, Math.min(side, viewportRoom()));
    let top = below ? rect.bottom + GAP : rect.top - GAP - height;
    top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));
    let left = rect.left;
    if (left + POPUP_WIDTH > window.innerWidth - MARGIN) {
      left = window.innerWidth - POPUP_WIDTH - MARGIN;
    }
    if (left < MARGIN) left = MARGIN;
    popup.style.left = Math.round(left) + "px";
    popup.style.top = Math.round(top) + "px";
  }
  function positionPopupCentered(popup) {
    const height = capAndMeasure(popup, viewportRoom());
    const left = Math.max(MARGIN, Math.round((window.innerWidth - POPUP_WIDTH) / 2));
    const top = Math.max(MARGIN, Math.round((window.innerHeight - height) / 2));
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }

  // src/time.js
  function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1e3);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // src/content.js
  function renderContent(data, instance, isMounted, showTimestamps = true) {
    if (!instance) return;
    const content = instance.querySelector(".rs-content");
    if (!content) return;
    const { recent, pinned } = data;
    const visitedAtByName = new Map(recent.map((s) => [s.name, s.visitedAt]));
    let html = "";
    if (pinned.length > 0) {
      html += '<div class="rs-section rs-pinned-section">';
      html += '<div class="rs-section-title">\u{1F4CC} Pinned</div>';
      html += '<ul class="rs-list">';
      pinned.forEach((name, i) => {
        const icon = cachedIcon(name);
        html += `<li class="rs-item rs-pinned">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(name)}" class="rs-link">r/${name}</a>`;
        if (showTimestamps) {
          const visitedAt = visitedAtByName.get(name);
          if (visitedAt) {
            html += `<span class="rs-time">${formatTimeAgo(visitedAt)}</span>`;
          }
        }
        html += `<button class="rs-reorder-up" data-name="${escAttr(encodeURIComponent(name))}" title="Move up" ${i === 0 ? "disabled" : ""}>\u25B2</button>`;
        html += `<button class="rs-reorder-down" data-name="${escAttr(encodeURIComponent(name))}" title="Move down" ${i === pinned.length - 1 ? "disabled" : ""}>\u25BC</button>`;
        html += `<button class="rs-unpin-btn" data-name="${escAttr(encodeURIComponent(name))}" title="Unpin">\u2715</button>`;
        html += `</li>`;
      });
      html += "</ul></div>";
    }
    const recentFiltered = recent.filter((s) => !pinned.includes(s.name));
    if (recentFiltered.length > 0) {
      html += '<div class="rs-section">';
      html += '<div class="rs-section-title">\u{1F550} Recent</div>';
      html += '<ul class="rs-list">';
      for (const sub of recentFiltered) {
        const icon = cachedIcon(sub.name);
        html += `<li class="rs-item">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(sub.name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(sub.name)}" class="rs-link">r/${sub.name}</a>`;
        if (showTimestamps) {
          const timeAgo = formatTimeAgo(sub.visitedAt);
          html += `<span class="rs-time">${timeAgo}</span>`;
        }
        html += `<button class="rs-pin-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Pin">\u{1F4CC}</button>`;
        html += `<button class="rs-remove-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Remove from history">\u{1F5D1}</button>`;
        html += `</li>`;
      }
      html += "</ul></div>";
    } else if (pinned.length === 0) {
      html += '<div class="rs-empty">No subreddits visited yet.</div>';
    }
    content.innerHTML = html;
    [...pinned, ...recentFiltered.map((s) => s.name)].forEach((name) => {
      fetchSubredditIcon(name, isMounted);
    });
  }

  // src/selector.js
  function cssEscape(value) {
    const s = String(value);
    if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
  }
  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return "";
    if (el.id && isUnique("#" + cssEscape(el.id))) {
      const id = "#" + cssEscape(el.id);
      if (id.length < 80) return id;
    }
    const testId = el.getAttribute("data-testid");
    if (testId) {
      const sel = `[data-testid="${cssEscape(testId)}"]`;
      if (isUnique(sel)) return sel;
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const candidate = parts.join(" > ");
      if (isUnique(candidate)) return candidate;
      node = parent;
    }
    return parts.join(" > ");
  }

  // src/picker.js
  var PICKER_STYLE_ID = "rs-picker-styles";
  var pickerActive = false;
  var pickerBox = null;
  var pickerHovered = null;
  var pickerOnPick = null;
  var pickerOnEnd = null;
  function pickerHintEl() {
    return document.getElementById("rs-picker-hint");
  }
  function pickerCleanup() {
    const hint = pickerHintEl();
    if (hint) hint.remove();
    document.removeEventListener("mousemove", pickerMove, true);
    document.removeEventListener("click", pickerClick, true);
    document.removeEventListener("keydown", pickerKey, true);
    document.removeEventListener("scroll", pickerMove, true);
    if (pickerBox) {
      pickerBox.remove();
      pickerBox = null;
    }
    pickerActive = false;
    if (pickerOnEnd) {
      const done = pickerOnEnd;
      pickerOnEnd = null;
      done();
    }
  }
  function pickerMove(e) {
    if (!pickerActive) return;
    const el = (
      /** @type {Element} */
      e.target
    );
    if (!el || el.nodeType !== 1) return;
    if (el.closest("#rs-popup, .rs-inline-host, #rs-picker-hint")) return;
    pickerHovered = el;
    const rect = el.getBoundingClientRect();
    const box = pickerBox;
    box.style.display = "block";
    box.style.top = rect.top + "px";
    box.style.left = rect.left + "px";
    box.style.width = rect.width + "px";
    box.style.height = rect.height + "px";
    const hint = pickerHintEl();
    if (hint) {
      hint.textContent = `${buildSelector(el)}  \u2014  click to use, Esc to cancel`;
    }
  }
  function pickerClick(e) {
    if (!pickerActive) return;
    e.preventDefault();
    e.stopPropagation();
    const el = pickerHovered;
    const selector = el ? buildSelector(el) : "";
    const onPick = pickerOnPick;
    pickerCleanup();
    if (selector && onPick) onPick(selector);
  }
  function pickerKey(e) {
    if (!pickerActive) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      pickerCleanup();
    }
  }
  function startPicker(onPick, onEnd) {
    if (pickerActive) pickerCleanup();
    if (!document.getElementById(PICKER_STYLE_ID)) {
      const style = document.createElement("style");
      style.id = PICKER_STYLE_ID;
      style.textContent = `
      #rs-picker-box {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        /* border-box: the 2px border must not inflate the box past the
           element's rect, or the outline sits 4px off the element it marks. */
        box-sizing: border-box;
        border: 2px solid #d93a00;
        background: rgba(217,58,0,0.12);
        border-radius: 2px;
        display: none;
      }
      #rs-picker-hint {
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        max-width: 90vw;
        padding: 6px 12px;
        font: 12px/1.4 monospace;
        color: #fff;
        background: rgba(0,0,0,0.85);
        border-radius: 4px;
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
      document.head.appendChild(style);
    }
    const box = document.createElement("div");
    box.id = "rs-picker-box";
    document.body.appendChild(box);
    const hint = document.createElement("div");
    hint.id = "rs-picker-hint";
    hint.textContent = "Hover an element and click it \u2014 Esc to cancel";
    document.body.appendChild(hint);
    pickerBox = box;
    pickerHovered = null;
    pickerOnPick = onPick;
    pickerOnEnd = onEnd;
    pickerActive = true;
    document.addEventListener("mousemove", pickerMove, true);
    document.addEventListener("click", pickerClick, true);
    document.addEventListener("keydown", pickerKey, true);
    document.addEventListener("scroll", pickerMove, true);
  }

  // src/settings-panel.js
  function renderSettingsPanel(instance, ctl2, openSection) {
    const host = instance;
    if (!host) return;
    const panel = host.querySelector(".rs-settings-panel");
    if (!panel) return;
    const settings = loadSettings();
    const hasHook = settings.targets.some((t) => t.mode === "hook");
    const modeOptions = (selected) => [
      ["hook", "Hook (open popup)"],
      ["replace", "Replace element"],
      ["prepend", "Prepend inside"],
      ["append", "Append inside"]
    ].map(
      ([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`
    ).join("");
    const eventOptions = (selected) => [
      ["both", "Hover + click"],
      ["hover", "Hover only"],
      ["click", "Click only"]
    ].map(
      ([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`
    ).join("");
    const targetRows = settings.targets.length ? settings.targets.map((t, i) => {
      const eventsCell = t.mode === "hook" ? `<select class="rs-select" data-role="events" data-index="${i}">${eventOptions(t.events)}</select>` : `<span class="rs-muted">\u2014</span>`;
      return `
            <li class="rs-target">
              <code class="rs-target-sel" title="${escAttr(t.selector)}">${escAttr(t.selector)}</code>
              <div class="rs-target-controls">
                <select class="rs-select" data-role="mode" data-index="${i}">${modeOptions(t.mode)}</select>
                ${eventsCell}
                <button class="rs-icon-btn" data-role="remove" data-index="${i}" title="Remove">\u2715</button>
              </div>
            </li>`;
    }).join("") : '<li class="rs-empty">No page targets yet.</li>';
    const sections = panel.querySelectorAll(".rs-acc-section");
    const currentOpen = Array.from(sections).findIndex((s) => s.classList.contains("rs-acc-open"));
    panel.innerHTML = `
    <div class="rs-accordion">
      <div class="rs-acc-section rs-acc-open">
        <button type="button" class="rs-acc-header">Hotkey</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <input class="rs-input rs-hotkey-input" type="text" readonly
                   value="${escAttr(settings.hotkey)}"
                   placeholder="Click and press a combination" />
            <div class="rs-hint">Click the field, then press the keys you want.
              Use at least one modifier (Ctrl / Alt / Shift / Meta).</div>
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Page targets</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <div class="rs-label-row">
              <button class="rs-btn rs-btn-small" data-role="pick">Pick element\u2026</button>
            </div>
            <div class="rs-hint">Pick an element on the page, then choose what it does.
              A hook opens the popup; the others render the list inline there.</div>
            <ul class="rs-targets">${targetRows}</ul>
            ${hasHook ? "" : `<div class="rs-warn">No hook configured, so hovering or
              clicking will not open the popup. Press <b>${escAttr(settings.hotkey)}</b>
              to open it, or add a hook above.</div>`}
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Blocked subreddits</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <textarea class="rs-input rs-blocked-input" rows="4" spellcheck="false"
                      placeholder="one subreddit per line">${escAttr(settings.blocked.join("\n"))}</textarea>
            <div class="rs-hint">One subreddit per line, without the r/ \u2014 the \u{1F5D1} button
              adds them here. A blocked subreddit is not tracked again, so delete its
              line to let it back into the list.</div>
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Display options</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <label class="rs-check">
              <input type="checkbox" class="rs-checkbox" data-role="hide-controls"
                     ${settings.hideRowControls ? "checked" : ""} />
              <span>Hide row controls until hover</span>
            </label>
            <div class="rs-hint">Hides each row's \u{1F4CC} and \u{1F5D1}, and the \u2715 in the header,
              until you hover the row they belong to. Keeps the list uncluttered.</div>
          </div>
          <div class="rs-field">
            <label class="rs-check">
              <input type="checkbox" class="rs-checkbox" data-role="show-timestamps"
                     ${settings.showTimestamps ? "checked" : ""} />
              <span>Show timestamps</span>
            </label>
            <div class="rs-hint">Shows relative timestamps (e.g. "5m ago") next to each
              subreddit in the Recent and Pinned lists. Uncheck for a cleaner look.</div>
          </div>
          <div class="rs-field">
            <label class="rs-label" for="rs-max-recent">Recent history size</label>
            <input class="rs-input rs-number-input" id="rs-max-recent" type="number"
                   data-role="max-recent" min="${MIN_MAX_RECENT}" max="${MAX_MAX_RECENT}"
                   step="1" value="${settings.maxRecent}" />
            <div class="rs-hint">How many recently visited subreddits to keep
              (${MIN_MAX_RECENT}\u2013${MAX_MAX_RECENT}). Pinned subreddits are always kept
              on top of this, so they never count against the limit.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="rs-status"></div>
    <div class="rs-actions">
      <button class="rs-btn" data-role="reset">Reset to default</button>
      <button class="rs-btn rs-btn-primary" data-role="done">Done</button>
    </div>
  `;
    const newSections = panel.querySelectorAll(".rs-acc-section");
    const defaultOpen = openSection ?? Math.max(currentOpen, 0);
    newSections.forEach((s, i) => s.classList.toggle("rs-acc-open", i === defaultOpen));
    panel.querySelectorAll(".rs-acc-header").forEach((header) => {
      header.addEventListener("click", () => {
        const section = header.closest(".rs-acc-section");
        const wasOpen = section.classList.contains("rs-acc-open");
        panel.querySelectorAll(".rs-acc-section").forEach((s) => s.classList.remove("rs-acc-open"));
        if (!wasOpen) section.classList.add("rs-acc-open");
      });
    });
    const input = panel.querySelector(".rs-hotkey-input");
    const say = (msg, kind) => {
      const el = panel.querySelector(".rs-status");
      if (!el) return;
      el.textContent = msg;
      el.className = "rs-status " + (kind === "error" ? "rs-status-error" : "rs-status-ok");
    };
    input.addEventListener("keydown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        input.blur();
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) {
        say("Press a key along with at least one modifier.", "error");
        return;
      }
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        say("Add a modifier (Ctrl / Alt / Shift / Meta).", "error");
        return;
      }
      const next = { ...loadSettings(), hotkey: combo };
      saveSettings(next);
      input.value = combo;
      ctl2.setActiveHotkey(parseHotkey(combo));
      input.blur();
      say(`Saved \u2014 press ${combo} to open the popup.`);
    });
    const updateTarget = (index, patch) => {
      const s = loadSettings();
      if (!s.targets[index]) return;
      Object.assign(s.targets[index], patch);
      saveSettings(s);
      ctl2.rerender(host);
      if ("mode" in patch) ctl2.applyTargets();
      const sel = panel.querySelector(`[data-role="mode"][data-index="${index}"]`);
      if (sel && "mode" in patch) sel.focus();
    };
    panel.querySelector('[data-role="pick"]').addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = ctl2.isPopupVisible();
      if (wasOpen) ctl2.togglePopup(false);
      startPicker(
        (selector) => {
          const s = loadSettings();
          if (s.targets.some((t) => t.selector === selector)) {
            say("That element is already in the list.", "error");
            return;
          }
          s.targets.push({ selector, mode: "hook", events: "both" });
          saveSettings(s);
          ctl2.rerender(host);
          say(`Added ${selector}`);
        },
        () => {
          ctl2.setSettingsOpen(true, host, 1);
          if (wasOpen) ctl2.togglePopup(true);
        }
      );
    });
    panel.querySelector(".rs-targets").addEventListener("click", (e) => {
      const btn = e.target.closest('[data-role="remove"]');
      if (!btn) return;
      e.stopPropagation();
      const s = loadSettings();
      s.targets.splice(Number(btn.dataset.index), 1);
      saveSettings(s);
      ctl2.rerender(host);
      ctl2.applyTargets();
      const hooksLeft = s.targets.some((t) => t.mode === "hook");
      say(
        hooksLeft ? "Target removed." : `Target removed \u2014 no hook left, so use ${s.hotkey} to open the popup.`,
        hooksLeft ? "ok" : "error"
      );
    });
    panel.querySelector(".rs-targets").addEventListener("change", (e) => {
      const sel = e.target.closest('[data-role="mode"], [data-role="events"]');
      if (!sel) return;
      e.stopPropagation();
      const index = Number(sel.dataset.index);
      const role = sel.dataset.role;
      updateTarget(index, role === "mode" ? { mode: sel.value } : { events: sel.value });
      say("Target updated.");
    });
    const blockedInput = panel.querySelector(".rs-blocked-input");
    blockedInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
    });
    blockedInput.addEventListener("change", () => {
      const names = blockedInput.value.split("\n").map((line) => line.trim().replace(/^\/?r\//i, "").toLowerCase()).filter(Boolean);
      const unique = [...new Set(names)];
      const s = loadSettings();
      saveSettings({ ...s, blocked: unique });
      ctl2.refreshList();
      say(unique.length ? `Saved ${unique.length} blocked subreddit(s).` : "Blocklist cleared.");
    });
    panel.querySelector('[data-role="hide-controls"]').addEventListener("change", (e) => {
      e.stopPropagation();
      const on = e.target.checked;
      saveSettings({ ...loadSettings(), hideRowControls: on });
      ctl2.applyControlVisibility();
      say(on ? "Row controls will show on hover." : "Row controls are always shown.");
    });
    panel.querySelector('[data-role="show-timestamps"]').addEventListener("change", (e) => {
      e.stopPropagation();
      const on = e.target.checked;
      saveSettings({ ...loadSettings(), showTimestamps: on });
      ctl2.refreshList();
      say(on ? "Timestamps will be shown." : "Timestamps will be hidden.");
    });
    const maxRecentInput = panel.querySelector('[data-role="max-recent"]');
    maxRecentInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
    });
    maxRecentInput.addEventListener("change", () => {
      const applied = clampMaxRecent(maxRecentInput.value);
      saveSettings({ ...loadSettings(), maxRecent: applied });
      maxRecentInput.value = String(applied);
      saveData(pruneRecent(loadData(), applied));
      ctl2.refreshList();
      say(`Keeping up to ${applied} recent subreddit(s).`);
    });
    panel.querySelector('[data-role="reset"]').addEventListener("click", (e) => {
      e.stopPropagation();
      saveSettings(defaultSettings());
      ctl2.setActiveHotkey(parseHotkey(DEFAULT_SETTINGS.hotkey));
      ctl2.applyTargets();
      ctl2.applyControlVisibility();
      ctl2.rerender(host);
      say(`Reset \u2014 ${DEFAULT_SETTINGS.hotkey}, and the built-in trigger restored.`);
    });
    panel.querySelector('[data-role="done"]').addEventListener("click", (e) => {
      e.stopPropagation();
      ctl2.setSettingsOpen(false, host);
    });
  }

  // src/inline.js
  var ctl = null;
  function initInline(shellCtl) {
    ctl = shellCtl;
  }
  function refreshInline(data) {
    for (const rec of inlineInstances.values()) {
      if (!document.body.contains(rec.host)) continue;
      ctl.render(data, rec.host.querySelector(".rs-inline"));
    }
  }
  var inlineInstances = /* @__PURE__ */ new Map();
  var INLINE_MODES = ["replace", "prepend", "append"];
  function buildInlineInstance() {
    const inst = ctl.buildPopupShell();
    inst.classList.remove("recent-subreddits-popup");
    inst.classList.add("rs-inline", "rs-instance");
    inst.removeAttribute("id");
    inst.classList.remove("visible");
    const close = (
      /** @type {HTMLElement|null} */
      inst.querySelector(".rs-close-btn")
    );
    if (close) close.title = "Remove this binding";
    return inst;
  }
  function matchElementBox(inst, el) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (rect.width > 0) {
      inst.style.width = rect.width + "px";
      inst.style.maxWidth = "100%";
    }
    if (cs.fontSize) inst.style.fontSize = cs.fontSize;
    if (cs.position !== "static") {
      inst.style.position = cs.position;
      if (cs.top !== "auto") inst.style.top = cs.top;
      if (cs.right !== "auto") inst.style.right = cs.right;
      if (cs.bottom !== "auto") inst.style.bottom = cs.bottom;
      if (cs.left !== "auto") inst.style.left = cs.left;
      if (cs.zIndex !== "auto") inst.style.zIndex = cs.zIndex;
    }
    if (cs.margin !== "0px") inst.style.margin = cs.margin;
    if (cs.boxSizing) inst.style.boxSizing = cs.boxSizing;
  }
  function mountInlineInstance(target) {
    const { selector, mode } = target;
    let el;
    try {
      el = document.querySelector(selector);
    } catch {
      return;
    }
    if (!el) return;
    let rec = inlineInstances.get(selector);
    if (rec && (rec.mode !== mode || !document.body.contains(rec.host))) {
      rec.host.remove();
      rec = null;
    }
    if (!rec) {
      const inst = buildInlineInstance();
      const host = document.createElement("div");
      host.className = "rs-inline-host" + (mode === "replace" ? " rs-inline-host-replace" : "");
      host.dataset.rsSelector = selector;
      host.appendChild(inst);
      const handle = document.createElement("div");
      handle.className = "rs-resize-handle";
      host.appendChild(handle);
      let promoted = false;
      if (mode === "replace") {
        if (getComputedStyle(el).position === "static") {
          el.style.position = "relative";
          promoted = true;
        }
        el.classList.add("rs-replacing");
        el.appendChild(host);
      } else if (mode === "prepend") {
        el.insertBefore(host, el.firstChild);
      } else {
        el.appendChild(host);
      }
      if (mode === "replace") matchElementBox(inst, el);
      if (target.size) {
        if (target.size.width) inst.style.width = target.size.width;
        if (target.size.height) inst.style.maxHeight = target.size.height;
      }
      rec = { el, host, mode, promoted };
      inlineInstances.set(selector, rec);
      wireInlineInstance(rec, target);
    }
    ctl.render(loadData(), rec.host.querySelector(".rs-inline"));
  }
  function wireResizeHandle(rec, target) {
    const handle = rec.host.querySelector(".rs-resize-handle");
    const inst = rec.host.querySelector(".rs-inline");
    if (!handle || !inst) return;
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = inst.offsetWidth;
      const startH = inst.offsetHeight;
      const onMove = (ev) => {
        const newW = Math.max(80, startW + ev.clientX - startX);
        const newH = Math.max(60, startH + ev.clientY - startY);
        inst.style.width = newW + "px";
        inst.style.maxHeight = newH + "px";
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        const s = loadSettings();
        const t = s.targets.find((t2) => t2.selector === target.selector);
        if (t) {
          t.size = { width: inst.style.width, maxHeight: inst.style.maxHeight };
          saveSettings(s);
        }
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
  }
  function wireInlineInstance(rec, target) {
    const inst = rec.host.querySelector(".rs-inline");
    if (!inst) return;
    wireResizeHandle(rec, target);
    inst.addEventListener("click", (e) => {
      const pin = e.target.closest(".rs-pin-btn, .rs-unpin-btn");
      if (pin) {
        e.stopPropagation();
        ctl.togglePin(pin.dataset.name);
        return;
      }
      const reorder = e.target.closest(".rs-reorder-up, .rs-reorder-down");
      if (reorder) {
        e.stopPropagation();
        ctl.movePinned(reorder.dataset.name, reorder.classList.contains("rs-reorder-up") ? "up" : "down");
        return;
      }
      const remove = e.target.closest(".rs-remove-btn");
      if (remove) {
        e.stopPropagation();
        ctl.removeVisit(remove.dataset.name);
        return;
      }
      if (e.target.closest(".rs-close-btn")) {
        e.stopPropagation();
        removeTargetBySelector(target.selector);
        return;
      }
      if (e.target.closest(".rs-back-btn")) {
        e.stopPropagation();
        ctl.setSettingsOpen(false, inst);
        return;
      }
      if (e.target.closest(".rs-settings-btn")) {
        e.stopPropagation();
        ctl.setSettingsOpen(!inst.classList.contains("settings-open"), inst);
      }
      e.stopPropagation();
    });
  }
  function removeTargetBySelector(selector) {
    const s = loadSettings();
    const i = s.targets.findIndex((t) => t.selector === selector);
    if (i < 0) return;
    s.targets.splice(i, 1);
    saveSettings(s);
    applyTargets();
  }
  function applyTargets() {
    if (!document.body) return;
    const wanted = loadSettings().targets.filter((t) => INLINE_MODES.includes(t.mode));
    for (const [selector, rec] of Array.from(inlineInstances.entries())) {
      const stillWanted = wanted.some((t) => t.selector === selector);
      if (!stillWanted) {
        if (rec.el) rec.el.classList.remove("rs-replacing");
        if (rec.promoted && rec.el) rec.el.style.position = "";
        rec.host.remove();
        inlineInstances.delete(selector);
      }
    }
    for (const t of wanted) mountInlineInstance(t);
  }

  // src/triggers.js
  function resolveTrigger(target) {
    if (!target || typeof target.closest !== "function") return null;
    for (const t of hookTargets()) {
      let el;
      try {
        el = target.closest(t.selector);
      } catch {
        continue;
      }
      if (el) return { el, events: t.events };
    }
    return null;
  }
  var wantsHover = (events) => events === "hover" || events === "both";
  var wantsClick = (events) => events === "click" || events === "both";

  // src/app.js
  var HEADER_TITLE = { main: "\u{1F4CB} Recent Subreddits", settings: "\u2699 Settings" };
  var sidebarEl = null;
  var popupEl = null;
  var settingsOpen = false;
  var refreshTimer = null;
  var REFRESH_INTERVAL_MS = 3e4;
  function isSettingsOpen() {
    return settingsOpen;
  }
  var panelCtl = {
    rerender: renderSettings,
    setSettingsOpen,
    isPopupVisible,
    togglePopup,
    applyTargets,
    refreshList,
    applyControlVisibility,
    // A setter, not a function reference: the panel replaces the active combo.
    setActiveHotkey: (combo) => {
      activeHotkey = combo;
    }
  };
  function renderSettings(instance, openSection) {
    renderSettingsPanel(instance || popupEl, panelCtl, openSection);
  }
  function refreshAll(data) {
    renderContent2(data);
    refreshInline(data);
  }
  function togglePin2(name) {
    togglePin(name, refreshAll);
  }
  function movePinned2(name, direction) {
    movePinned(name, direction, refreshAll);
  }
  function removeVisit2(name) {
    removeVisit(name, refreshAll);
  }
  function refreshList() {
    refreshAll(loadData());
    repositionPopup();
  }
  function applyControlVisibility() {
    const hide = loadSettings().hideRowControls;
    for (const el of document.querySelectorAll(".rs-instance")) {
      el.classList.toggle("rs-hide-controls", hide);
    }
  }
  function buildPopupShell() {
    const popup = document.createElement("div");
    popup.className = "recent-subreddits-popup rs-instance";
    popup.id = "rs-popup";
    if (loadSettings().hideRowControls) popup.classList.add("rs-hide-controls");
    const close = document.createElement("button");
    close.className = "rs-close-btn";
    close.id = "rs-close";
    close.title = "Close";
    close.textContent = "\u2715";
    const header = document.createElement("div");
    header.className = "rs-header-row";
    const title = document.createElement("h3");
    title.className = "rs-header";
    title.textContent = HEADER_TITLE.main;
    const back = document.createElement("button");
    back.className = "rs-back-btn";
    back.id = "rs-back";
    back.title = "Back";
    back.textContent = "\u2190";
    const gear = document.createElement("button");
    gear.className = "rs-settings-btn";
    gear.id = "rs-settings";
    gear.title = "Settings";
    gear.textContent = "\u2699";
    header.append(back, title, gear, close);
    const content = document.createElement("div");
    content.className = "rs-content";
    const settings = document.createElement("div");
    settings.className = "rs-settings-panel";
    popup.append(header, content, settings);
    return popup;
  }
  function renderContent2(data, instance) {
    renderContent(data, instance || popupEl, () => !!sidebarEl, loadSettings().showTimestamps);
  }
  function harvestIcon() {
    const adopted = harvestCurrentSubredditIcon(() => !!sidebarEl);
    if (adopted && sidebarEl) renderContent2(loadData());
    checkHarvest(harvestSignals());
  }
  function setSettingsOpen(open, instance, openSection) {
    const host = instance || popupEl;
    if (!host) return;
    if (host === popupEl) settingsOpen = open;
    host.classList.toggle("settings-open", open);
    const title = host.querySelector(".rs-header");
    if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
    if (open) renderSettings(host, openSection);
    if (host === popupEl) repositionPopup();
  }
  var activeHotkey = null;
  var lastTrigger = null;
  function startRefreshTimer() {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => {
      if (isPopupVisible()) refreshList();
    }, REFRESH_INTERVAL_MS);
  }
  function stopRefreshTimer() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }
  function togglePopup(show, trigger) {
    if (!popupEl) return;
    if (show) {
      if (trigger) lastTrigger = trigger;
      harvestIcon();
      popupEl.classList.add("visible");
      if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
      else positionPopupCentered(popupEl);
      startRefreshTimer();
    } else {
      popupEl.classList.remove("visible");
      stopRefreshTimer();
      setSettingsOpen(false);
    }
  }
  function isPopupVisible() {
    return !!popupEl && popupEl.classList.contains("visible");
  }
  function repositionPopup() {
    if (!isPopupVisible()) return;
    if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
    else positionPopupCentered(popupEl);
  }
  function ensureMounted() {
    if (!sidebarEl) return;
    if (!document.body.contains(sidebarEl)) {
      document.body.appendChild(sidebarEl);
    }
    if (!document.getElementById("rs-styles")) {
      injectStyles();
    }
  }
  function mountSidebar() {
    initInline({
      buildPopupShell,
      render: renderContent2,
      togglePin: togglePin2,
      movePinned: movePinned2,
      removeVisit: removeVisit2,
      setSettingsOpen
    });
    if (!sidebarEl) {
      sidebarEl = document.createElement("div");
      sidebarEl.className = "recent-subreddits-container";
      document.body.appendChild(sidebarEl);
      popupEl = buildPopupShell();
      sidebarEl.appendChild(popupEl);
      activeHotkey = parseHotkey(loadSettings().hotkey);
      harvestIcon();
      renderContent2(loadData());
      applyTargets();
      applyControlVisibility();
    } else {
      ensureMounted();
      applyTargets();
    }
    sidebarEl.addEventListener("click", (e) => {
      const pin = e.target.closest(".rs-pin-btn, .rs-unpin-btn");
      if (pin) {
        e.stopPropagation();
        togglePin2(pin.dataset.name);
        return;
      }
      const reorder = e.target.closest(".rs-reorder-up, .rs-reorder-down");
      if (reorder) {
        e.stopPropagation();
        movePinned2(reorder.dataset.name, reorder.classList.contains("rs-reorder-up") ? "up" : "down");
        return;
      }
      const remove = e.target.closest(".rs-remove-btn");
      if (remove) {
        e.stopPropagation();
        removeVisit2(remove.dataset.name);
        return;
      }
      if (e.target.closest(".rs-close-btn")) {
        e.stopPropagation();
        togglePopup(false);
        return;
      }
      if (e.target.closest(".rs-back-btn")) {
        e.stopPropagation();
        setSettingsOpen(false);
      }
      if (e.target.closest(".rs-settings-btn")) {
        e.stopPropagation();
        setSettingsOpen(!isSettingsOpen());
      }
      e.stopPropagation();
    });
    sidebarEl.addEventListener("mouseleave", () => {
      setTimeout(() => {
        if (!isPopupVisible()) return;
        if (popupEl && !popupEl.matches(":hover")) togglePopup(false);
      }, 300);
    });
    document.addEventListener("mouseover", (e) => {
      const hit = resolveTrigger(e.target);
      if (!hit || !wantsHover(hit.events)) return;
      if (e.relatedTarget && hit.el.contains(e.relatedTarget)) return;
      togglePopup(true, hit.el);
    });
    document.addEventListener("click", (e) => {
      const hit = resolveTrigger(e.target);
      if (hit && wantsClick(hit.events)) {
        if (isPopupVisible()) {
          togglePopup(false);
        } else {
          e.preventDefault();
          togglePopup(true, hit.el);
        }
        return;
      }
      if (hit) return;
      if (!isPopupVisible()) return;
      if (popupEl && !popupEl.contains(e.target)) {
        togglePopup(false);
      }
    });
    document.addEventListener("keydown", (e) => {
      const target = (
        /** @type {HTMLElement} */
        e.target
      );
      if (target && target.classList && target.classList.contains("rs-hotkey-input")) return;
      if (e.key === "Escape") {
        if (isSettingsOpen()) {
          setSettingsOpen(false);
          return;
        }
        togglePopup(false);
        return;
      }
      if (hotkeyMatches(e, activeHotkey)) {
        e.preventDefault();
        if (isPopupVisible()) togglePopup(false);
        else togglePopup(true);
      }
    });
    checkTriggers(hookTargets().map((t) => t.selector));
  }
  function observeNavigation() {
    let lastUrl = window.location.href;
    const observer = new MutationObserver(() => {
      ensureMounted();
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const subName = getSubredditFromUrl();
        if (subName) {
          trackVisit(subName);
        }
        harvestIcon();
        renderContent2(loadData());
        applyTargets();
        checkTriggers(hookTargets().map((t) => t.selector));
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function init() {
    injectStyles();
    const subName = getSubredditFromUrl();
    if (subName) {
      trackVisit(subName);
    }
    mountSidebar();
    observeNavigation();
    harvestIcon();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
