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

  // src/storage.js
  var STORAGE_KEY = "recentSubreddits";
  var MAX_RECENT = 15;
  function loadData() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return { recent: [], pinned: [] };
      const parsed = JSON.parse(raw);
      return {
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : []
      };
    } catch {
      return { recent: [], pinned: [] };
    }
  }
  function saveData(data) {
    GM_setValue(STORAGE_KEY, JSON.stringify(data));
  }
  var SETTINGS_KEY = "recentSubredditsSettings";
  var DEFAULT_SETTINGS = { hotkey: "Alt+Shift+R", targets: [] };
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
  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) return { hotkey: DEFAULT_SETTINGS.hotkey, targets: [] };
      const parsed = JSON.parse(raw);
      return {
        hotkey: typeof parsed.hotkey === "string" && parsed.hotkey.trim() ? parsed.hotkey.trim() : DEFAULT_SETTINGS.hotkey,
        targets: normalizeTargets(parsed.targets)
      };
    } catch {
      return { hotkey: DEFAULT_SETTINGS.hotkey, targets: [] };
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
  var warned = /* @__PURE__ */ new Set();
  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[recent-subreddits] ${message}`);
  }
  function countTriggers() {
    try {
      return document.querySelectorAll(TRIGGER_SELECTOR).length;
    } catch {
      return 0;
    }
  }
  function checkTriggers() {
    if (countTriggers() > 0) return;
    warnOnce(
      "triggers",
      `no popup trigger matched on this page (selectors: ${TRIGGER_SELECTOR}). Hovering the logo will not open the popup. Use the hotkey instead, and report this so the selectors can be updated.`
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
      max-height: 70vh;
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
    .rs-hint {
      font-size: 11px;
      color: var(--rs-text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }
    .rs-status {
      font-size: 11px;
      min-height: 14px;
      margin-bottom: 4px;
    }
    .rs-status-ok { color: var(--rs-ok); }
    .rs-status-error { color: var(--rs-error); }

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
      background: transparent;
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
  function trackVisit(name) {
    const data = loadData();
    data.recent = data.recent.filter((s) => s.name !== name);
    data.recent.unshift({
      name,
      visitedAt: Date.now()
    });
    data.recent = data.recent.slice(0, MAX_RECENT);
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

  // src/position.js
  var POPUP_WIDTH = 280;
  var GAP = 8;
  var MARGIN = 16;
  function positionPopup(popup, trigger) {
    const rect = trigger.getBoundingClientRect();
    const popupHeight = popup.offsetHeight || 300;
    let left = rect.left;
    if (left + POPUP_WIDTH > window.innerWidth - MARGIN) {
      left = window.innerWidth - POPUP_WIDTH - MARGIN;
    }
    if (left < MARGIN) left = MARGIN;
    let top = rect.bottom + GAP;
    if (top + popupHeight > window.innerHeight - MARGIN) {
      const aboveTop = rect.top - popupHeight - GAP;
      if (aboveTop >= MARGIN) {
        top = aboveTop;
      } else {
        top = Math.max(MARGIN, Math.min(top, window.innerHeight - popupHeight - MARGIN));
      }
    }
    popup.style.left = left + "px";
    popup.style.top = top + "px";
  }
  function positionPopupCentered(popup) {
    const height = popup.offsetHeight || 300;
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

  // src/icons.js
  var DEFAULT_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";
  var iconCache = {};
  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }
  function cachedIcon(name) {
    return iconCache[name] || DEFAULT_ICON;
  }
  function updateIconInDom(name, icon, isMounted) {
    if (!isMounted() || !icon) return;
    const encoded = encodeURIComponent(name);
    const icons = document.querySelectorAll("img.rs-icon");
    icons.forEach((img) => {
      if (img.dataset.name === encoded) img.src = icon;
    });
  }
  function fetchSubredditIcon(name, isMounted) {
    if (name in iconCache) return iconCache[name];
    iconCache[name] = DEFAULT_ICON;
    GM_xmlhttpRequest({
      method: "GET",
      url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
      headers: { Accept: "application/json" },
      onload(res) {
        let icon = "";
        try {
          const data = JSON.parse(res.responseText);
          icon = data.data?.icon_img || data.data?.community_icon || "";
        } catch {
        }
        icon = icon.replace(/&amp;/g, "&");
        iconCache[name] = icon || DEFAULT_ICON;
        updateIconInDom(name, iconCache[name], isMounted);
      },
      onerror() {
        iconCache[name] = DEFAULT_ICON;
      }
    });
    return DEFAULT_ICON;
  }

  // src/content.js
  function renderContent(data, instance, isMounted) {
    if (!instance) return;
    const content = instance.querySelector(".rs-content");
    if (!content) return;
    const { recent, pinned } = data;
    let html = "";
    if (pinned.length > 0) {
      html += '<div class="rs-section rs-pinned-section">';
      html += '<div class="rs-section-title">\u{1F4CC} Pinned</div>';
      html += '<ul class="rs-list">';
      for (const name of pinned) {
        const icon = cachedIcon(name);
        html += `<li class="rs-item rs-pinned">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(name)}" class="rs-link">r/${name}</a>`;
        html += `<button class="rs-unpin-btn" data-name="${escAttr(encodeURIComponent(name))}" title="Unpin">\u2715</button>`;
        html += `</li>`;
      }
      html += "</ul></div>";
    }
    const recentFiltered = recent.filter((s) => !pinned.includes(s.name));
    if (recentFiltered.length > 0) {
      html += '<div class="rs-section">';
      html += '<div class="rs-section-title">\u{1F550} Recent</div>';
      html += '<ul class="rs-list">';
      for (const sub of recentFiltered) {
        const timeAgo = formatTimeAgo(sub.visitedAt);
        const icon = cachedIcon(sub.name);
        html += `<li class="rs-item">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(sub.name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(sub.name)}" class="rs-link">r/${sub.name}</a>`;
        html += `<span class="rs-time">${timeAgo}</span>`;
        html += `<button class="rs-pin-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Pin">\u{1F4CC}</button>`;
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
  function renderSettingsPanel(instance, ctl2) {
    const host = instance;
    if (!host) return;
    const panel = host.querySelector(".rs-settings-panel");
    if (!panel) return;
    const settings = loadSettings();
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
    panel.innerHTML = `
    <div class="rs-field">
      <label class="rs-label">Open popup hotkey</label>
      <input class="rs-input rs-hotkey-input" type="text" readonly
             value="${escAttr(settings.hotkey)}"
             placeholder="Click and press a combination" />
      <div class="rs-hint">Click the field, then press the keys you want.
        Use at least one modifier (Ctrl / Alt / Shift / Meta).</div>
    </div>

    <div class="rs-field">
      <div class="rs-label-row">
        <label class="rs-label">Page targets</label>
        <button class="rs-btn rs-btn-small" data-role="pick">Pick element\u2026</button>
      </div>
      <div class="rs-hint">Pick an element on the page, then choose what it does.
        A hook opens the popup; the others render the list inline there.</div>
      <ul class="rs-targets">${targetRows}</ul>
    </div>

    <div class="rs-status"></div>
    <div class="rs-actions">
      <button class="rs-btn" data-role="reset">Reset to default</button>
      <button class="rs-btn rs-btn-primary" data-role="done">Done</button>
    </div>
  `;
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
          ctl2.setSettingsOpen(true);
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
      say("Target removed.");
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
    panel.querySelector('[data-role="reset"]').addEventListener("click", (e) => {
      e.stopPropagation();
      saveSettings({ ...DEFAULT_SETTINGS });
      ctl2.setActiveHotkey(parseHotkey(DEFAULT_SETTINGS.hotkey));
      ctl2.applyTargets();
      ctl2.rerender(host);
      say(`Reset to ${DEFAULT_SETTINGS.hotkey}.`);
    });
    panel.querySelector('[data-role="done"]').addEventListener("click", (e) => {
      e.stopPropagation();
      ctl2.setSettingsOpen(false);
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
        el.style.visibility = "hidden";
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
        if (rec.el && rec.el.style.visibility === "hidden") rec.el.style.visibility = "";
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
    const builtin = target.closest(TRIGGER_SELECTOR);
    if (builtin) return { el: builtin, events: "both" };
    return null;
  }
  var wantsHover = (events) => events === "hover" || events === "both";
  var wantsClick = (events) => events === "click" || events === "both";

  // src/app.js
  var HEADER_TITLE = { main: "\u{1F4CB} Recent Subreddits", settings: "\u2699 Settings" };
  var sidebarEl = null;
  var popupEl = null;
  var settingsOpen = false;
  function isSettingsOpen() {
    return settingsOpen;
  }
  var panelCtl = {
    rerender: renderSettings,
    setSettingsOpen,
    isPopupVisible,
    togglePopup,
    applyTargets,
    // A setter, not a function reference: the panel replaces the active combo.
    setActiveHotkey: (combo) => {
      activeHotkey = combo;
    }
  };
  function renderSettings(instance) {
    renderSettingsPanel(instance || popupEl, panelCtl);
  }
  function refreshAll(data) {
    renderContent2(data);
    refreshInline(data);
  }
  function togglePin2(name) {
    togglePin(name, refreshAll);
  }
  function buildPopupShell() {
    const popup = document.createElement("div");
    popup.className = "recent-subreddits-popup rs-instance";
    popup.id = "rs-popup";
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
    renderContent(data, instance || popupEl, () => !!sidebarEl);
  }
  function setSettingsOpen(open, instance) {
    const host = instance || popupEl;
    if (!host) return;
    if (host === popupEl) settingsOpen = open;
    host.classList.toggle("settings-open", open);
    const title = host.querySelector(".rs-header");
    if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
    if (open) renderSettings(host);
  }
  var activeHotkey = null;
  var lastTrigger = null;
  function togglePopup(show, trigger) {
    if (!popupEl) return;
    if (show) {
      if (trigger) lastTrigger = trigger;
      popupEl.classList.add("visible");
      if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
      else positionPopupCentered(popupEl);
    } else {
      popupEl.classList.remove("visible");
      setSettingsOpen(false);
    }
  }
  function isPopupVisible() {
    return !!popupEl && popupEl.classList.contains("visible");
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
      setSettingsOpen
    });
    if (!sidebarEl) {
      sidebarEl = document.createElement("div");
      sidebarEl.className = "recent-subreddits-container";
      document.body.appendChild(sidebarEl);
      popupEl = buildPopupShell();
      sidebarEl.appendChild(popupEl);
      activeHotkey = parseHotkey(loadSettings().hotkey);
      renderContent2(loadData());
      applyTargets();
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
    checkTriggers();
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
        renderContent2(loadData());
        applyTargets();
        checkTriggers();
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
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
