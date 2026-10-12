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

(function () {
  'use strict';

  // ---------- Storage ----------
  const STORAGE_KEY = 'recentSubreddits';
  const MAX_RECENT = 15;

  function loadData() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return { recent: [], pinned: [] };
      const parsed = JSON.parse(raw);
      return {
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      };
    } catch {
      return { recent: [], pinned: [] };
    }
  }

  function saveData(data) {
    GM_setValue(STORAGE_KEY, JSON.stringify(data));
  }

  // ---------- Settings ----------
  const SETTINGS_KEY = 'recentSubredditsSettings';

  // The escape hatch: a shortcut that opens the popup without depending on any
  // Reddit selector. If the header markup changes and the logo stops matching,
  // this still works, so a markup change degrades the feature instead of killing it.
  const DEFAULT_SETTINGS = { hotkey: 'Alt+Shift+R' };

  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) return { ...DEFAULT_SETTINGS };
      const parsed = JSON.parse(raw);
      return {
        hotkey:
          typeof parsed.hotkey === 'string' && parsed.hotkey.trim()
            ? parsed.hotkey.trim()
            : DEFAULT_SETTINGS.hotkey,
      };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(settings) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
  }

  // ---------- Hotkey parsing ----------
  // Stored as a human-readable string ("Alt+Shift+R") because that is what a
  // settings field and a bug report can carry. Parsed once, on keydown.
  function parseHotkey(str) {
    const parts = String(str).split('+').map((p) => p.trim()).filter(Boolean);
    const combo = { ctrl: false, alt: false, shift: false, meta: false, key: null };

    for (const part of parts) {
      const p = part.toLowerCase();
      if (p === 'ctrl' || p === 'control') combo.ctrl = true;
      else if (p === 'alt' || p === 'option') combo.alt = true;
      else if (p === 'shift') combo.shift = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') combo.meta = true;
      else combo.key = p;
    }

    // A bare modifier is not a shortcut.
    return combo.key ? combo : null;
  }

  function hotkeyMatches(event, combo) {
    if (!combo) return false;
    if (event.ctrlKey !== combo.ctrl) return false;
    if (event.altKey !== combo.alt) return false;
    if (event.shiftKey !== combo.shift) return false;
    if (event.metaKey !== combo.meta) return false;
    // event.key for a letter is case-sensitive ('R' when shift is held).
    return String(event.key).toLowerCase() === combo.key;
  }

  // Turn a keydown into a stored combo string, or null if only modifiers are down.
  function comboFromEvent(event) {
    const key = event.key;
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    if (event.metaKey) parts.push('Meta');

    // Prefer a printable label: 'r' -> 'R', 'ArrowUp' -> 'ArrowUp'.
    const label = key.length === 1 ? key.toUpperCase() : key;
    parts.push(label);
    return parts.join('+');
  }

  // ---------- Diagnostics ----------
  // One warn per condition per page, so a broken selector is visible in the
  // console without spamming it. Silent when everything matches, which is the
  // normal case.
  const warned = new Set();

  function warnOnce(key, message) {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(`[recent-subreddits] ${message}`);
  }

  // How many elements currently match the popup triggers. 0 means the feature is
  // unreachable by hover/click — the signature of a Reddit markup change.
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
      'triggers',
      `no popup trigger matched on this page (selectors: ${TRIGGER_SELECTOR}). ` +
        `Hovering the logo will not open the popup. Use the hotkey instead, ` +
        `and report this so the selectors can be updated.`
    );
  }

  // ---------- Subreddit icon cache ----------
  const DEFAULT_ICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";

  const iconCache = {};

  function escAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function updateIconInDom(name, icon) {
    if (!sidebarEl || !icon) return;
    const encoded = encodeURIComponent(name);
    sidebarEl.querySelectorAll('img.rs-icon').forEach((img) => {
      if (img.dataset.name === encoded) img.src = icon;
    });
  }

  function fetchSubredditIcon(name) {
    // `name in iconCache` also covers the placeholder set below, so we never
    // fire the same request twice (including after a failed fetch).
    if (name in iconCache) return iconCache[name];

    iconCache[name] = DEFAULT_ICON; // placeholder while loading

    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
      headers: { Accept: 'application/json' },
      onload(res) {
        let icon = '';
        try {
          const data = JSON.parse(res.responseText);
          icon = data.data?.icon_img || data.data?.community_icon || '';
        } catch { /* ignore */ }
        // Reddit sometimes returns an HTML-escaped URL
        icon = icon.replace(/&amp;/g, '&');
        iconCache[name] = icon || DEFAULT_ICON;
        updateIconInDom(name, iconCache[name]);
      },
      onerror() {
        iconCache[name] = DEFAULT_ICON;
      },
    });

    return DEFAULT_ICON;
  }

  // ---------- Extract subreddit from URL ----------
  function getSubredditFromUrl() {
    const path = window.location.pathname;
    // Matches /r/subreddit/... or /r/subreddit
    const match = path.match(/^\/r\/([^/]+)/i);
    if (match) {
      const name = match[1];
      // Skip special entries like "friends", "popular", "all" if desired — keep them for now
      return name.toLowerCase();
    }
    return null;
  }

  // ---------- Track subreddit visit ----------
  function trackVisit(name) {
    const data = loadData();
    // Remove if already in recent (will re-add at top)
    data.recent = data.recent.filter((s) => s.name !== name);
    data.recent.unshift({
      name,
      visitedAt: Date.now(),
    });
    // Trim
    data.recent = data.recent.slice(0, MAX_RECENT);
    saveData(data);
  }

  // ---------- Toggle pin ----------
  function togglePin(name) {
    const data = loadData();
    const pinIndex = data.pinned.indexOf(name);
    if (pinIndex >= 0) {
      data.pinned.splice(pinIndex, 1);
    } else {
      data.pinned.unshift(name);
    }
    saveData(data);
    renderContent(data);
  }

  // ---------- Build sidebar element ----------
  let sidebarEl = null;
  let popupEl = null; // persistent; rebuilt content goes inside #rs-content
  let settingsOpen = false;

  function isSettingsOpen() {
    return settingsOpen;
  }

  /**
   * Build the popup's static shell ONCE. Its inner structure never changes, so
   * the node itself survives every content re-render — which is what lets the
   * settings modal stay open while pins change underneath it.
   */
  function buildPopupShell() {
    const popup = document.createElement('div');
    popup.className = 'recent-subreddits-popup';
    popup.id = 'rs-popup';

    const close = document.createElement('button');
    close.className = 'rs-close-btn';
    close.id = 'rs-close';
    close.title = 'Close';
    close.textContent = '✕';

    const header = document.createElement('div');
    header.className = 'rs-header-row';

    const title = document.createElement('h3');
    title.className = 'rs-header';
    title.textContent = '📋 Recent Subreddits';

    const gear = document.createElement('button');
    gear.className = 'rs-settings-btn';
    gear.id = 'rs-settings';
    gear.title = 'Settings';
    gear.textContent = '⚙';

    header.append(title, gear);

    const content = document.createElement('div');
    content.className = 'rs-content';
    content.id = 'rs-content';

    const settings = document.createElement('div');
    settings.className = 'rs-settings-panel';
    settings.id = 'rs-settings-panel';

    popup.append(close, header, content, settings);
    return popup;
  }

  /** Render the recent/pinned list into the stable content node. */
  function renderContent(data) {
    if (!sidebarEl || !popupEl) return;

    const content = popupEl.querySelector('#rs-content');
    if (!content) return;

    const { recent, pinned } = data;

    let html = '';

    if (pinned.length > 0) {
      html += '<div class="rs-section rs-pinned-section">';
      html += '<div class="rs-section-title">📌 Pinned</div>';
      html += '<ul class="rs-list">';
      for (const name of pinned) {
        const icon = iconCache[name] || DEFAULT_ICON;
        html += `<li class="rs-item rs-pinned">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(name)}" class="rs-link">r/${name}</a>`;
        html += `<button class="rs-unpin-btn" data-name="${escAttr(encodeURIComponent(name))}" title="Unpin">✕</button>`;
        html += `</li>`;
      }
      html += '</ul></div>';
    }

    const recentFiltered = recent.filter((s) => !pinned.includes(s.name));

    if (recentFiltered.length > 0) {
      html += '<div class="rs-section">';
      html += '<div class="rs-section-title">🕐 Recent</div>';
      html += '<ul class="rs-list">';
      for (const sub of recentFiltered) {
        const timeAgo = formatTimeAgo(sub.visitedAt);
        const icon = iconCache[sub.name] || DEFAULT_ICON;
        html += `<li class="rs-item">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(sub.name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(sub.name)}" class="rs-link">r/${sub.name}</a>`;
        html += `<span class="rs-time">${timeAgo}</span>`;
        html += `<button class="rs-pin-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Pin">📌</button>`;
        html += `</li>`;
      }
      html += '</ul></div>';
    } else if (pinned.length === 0) {
      html += '<div class="rs-empty">No subreddits visited yet.</div>';
    }

    content.innerHTML = html;

    // Fetch icons for any entries missing one
    [...pinned, ...recentFiltered.map((s) => s.name)].forEach((name) => {
      if (!iconCache[name]) fetchSubredditIcon(name);
    });
  }

  /** Render the settings modal body into its stable node. */
  function renderSettings() {
    if (!popupEl) return;
    const panel = popupEl.querySelector('#rs-settings-panel');
    if (!panel) return;

    const settings = loadSettings();

    panel.innerHTML = `
      <div class="rs-field">
        <label class="rs-label" for="rs-hotkey-input">Open popup hotkey</label>
        <input class="rs-input" id="rs-hotkey-input" type="text" readonly
               value="${escAttr(settings.hotkey)}"
               placeholder="Click and press a combination" />
        <div class="rs-hint">Click the field, then press the keys you want.
          Use at least one modifier (Ctrl / Alt / Shift / Meta).</div>
      </div>
      <div class="rs-status" id="rs-status"></div>
      <div class="rs-actions">
        <button class="rs-btn" id="rs-reset">Reset to default</button>
        <button class="rs-btn rs-btn-primary" id="rs-done">Done</button>
      </div>
    `;

    const input = panel.querySelector('#rs-hotkey-input');
    const status = panel.querySelector('#rs-status');

    // Capture the combination: the field is readonly so nothing is typed into it,
    // and the whole keydown is consumed so the host page never sees it.
    input.addEventListener('keydown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (e.key === 'Escape') {
        input.blur();
        return;
      }

      const combo = comboFromEvent(e);
      if (!combo) {
        status.textContent = 'Press a key along with at least one modifier.';
        status.className = 'rs-status rs-status-error';
        return;
      }

      // Require a modifier: a bare letter would fire while the user is typing in
      // Reddit's own search box.
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        status.textContent = 'Add a modifier (Ctrl / Alt / Shift / Meta).';
        status.className = 'rs-status rs-status-error';
        return;
      }

      const next = { ...loadSettings(), hotkey: combo };
      saveSettings(next);
      input.value = combo;
      activeHotkey = parseHotkey(combo);
      // Release focus: while the field is focused the global handler ignores
      // keydown (the field owns the keys), so leaving it focused would make the
      // hotkey appear not to work until the user clicked elsewhere.
      input.blur();
      status.textContent = `Saved — press ${combo} to open the popup.`;
      status.className = 'rs-status rs-status-ok';
    });

    panel.querySelector('#rs-reset').addEventListener('click', (e) => {
      e.stopPropagation();
      saveSettings({ ...DEFAULT_SETTINGS });
      activeHotkey = parseHotkey(DEFAULT_SETTINGS.hotkey);
      renderSettings();
      const s = panel.querySelector('#rs-status');
      s.textContent = `Reset to ${DEFAULT_SETTINGS.hotkey}.`;
      s.className = 'rs-status rs-status-ok';
    });

    panel.querySelector('#rs-done').addEventListener('click', (e) => {
      e.stopPropagation();
      setSettingsOpen(false);
    });
  }

  function setSettingsOpen(open) {
    settingsOpen = open;
    if (!popupEl) return;

    popupEl.classList.toggle('settings-open', open);
    if (open) renderSettings();
  }

  // Kept in a module-level variable so the hotkey can change without rebinding.
  let activeHotkey = null;

  function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ---------- Inject styles ----------
  function injectStyles() {
    if (document.getElementById('rs-styles')) return;
    const style = document.createElement('style');
    style.id = 'rs-styles';
    style.textContent = `
      /* Popup container — hidden by default */
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
        justify-content: space-between;
        gap: 8px;
        margin: 0 0 8px 0;
      }
      .rs-header {
        margin: 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--rs-text);
      }
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
      /* Hidden by default; the popup swaps content for it when .settings-open. */
      .rs-settings-panel { display: none; }
      .recent-subreddits-popup.settings-open .rs-content { display: none; }
      .recent-subreddits-popup.settings-open .rs-settings-panel { display: block; }

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
        margin-bottom: 8px;
      }
      .rs-status-ok { color: var(--rs-ok); }
      .rs-status-error { color: var(--rs-error); }
      .rs-actions {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .rs-btn {
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
      .rs-close-btn {
        position: absolute;
        top: 6px;
        right: 8px;
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

  // ---------- Popup positioning ----------
  function positionPopup(trigger) {
    if (!popupEl) return;
    const popup = popupEl;

    const rect = trigger.getBoundingClientRect();
    const popupWidth = 280;
    const popupHeight = popup.offsetHeight || 300;
    const gap = 8;
    const margin = 16;

    // Horizontal: align left edge with trigger, clamp to viewport
    let left = rect.left;
    if (left + popupWidth > window.innerWidth - margin) {
      left = window.innerWidth - popupWidth - margin;
    }
    if (left < margin) left = margin;

    // Vertical: prefer below trigger, flip above if not enough space
    let top = rect.bottom + gap;
    if (top + popupHeight > window.innerHeight - margin) {
      const aboveTop = rect.top - popupHeight - gap;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else {
        // Neither fits — clamp to viewport with margin
        top = Math.max(margin, Math.min(top, window.innerHeight - popupHeight - margin));
      }
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  // Centre the popup when opened by hotkey (no trigger to anchor to).
  function positionPopupCentered() {
    if (!popupEl) return;
    const popup = popupEl;
    const width = 280;
    const height = popup.offsetHeight || 300;
    const margin = 16;

    const left = Math.max(margin, Math.round((window.innerWidth - width) / 2));
    const top = Math.max(margin, Math.round((window.innerHeight - height) / 2));

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  // ---------- Popup toggle ----------
  function togglePopup(show, trigger) {
    if (!popupEl) return;
    if (show) {
      popupEl.classList.add('visible');
      if (trigger) positionPopup(trigger);
      else positionPopupCentered();
    } else {
      popupEl.classList.remove('visible');
      // Never leave the settings modal open behind a closed popup.
      setSettingsOpen(false);
    }
  }

  function isPopupVisible() {
    return !!popupEl && popupEl.classList.contains('visible');
  }

  // ---------- Mount popup ----------
  // Combined selector for every element that should trigger the popup.
  // Used with Element.closest() so listeners can live on `document` instead of
  // on the trigger nodes — the host re-renders its header on SPA navigation and
  // would otherwise swap in replacement nodes that carry no listeners.
  const TRIGGER_SELECTOR = [
    'a[href="/"]',                       // Reddit logo link
    '#header-logo',                      // Old Reddit logo
    '.header-logo',                      // Alternative logo class
    '[data-testid="top-nav-logo"]',      // New Reddit logo
    'button[aria-label*="menu" i]',      // Menu button
    '#TopNav button',                    // Top nav button area
    '#reddit-logo',
    '#navbar-menu-button',
  ].join(', ');

  // ---------- Keep our own nodes alive ----------
  // The wrapper lives on document.body, but the host can replace body content
  // (or head) on navigation. Re-append if we were detached.
  function ensureMounted() {
    if (!sidebarEl) return;

    if (!document.body.contains(sidebarEl)) {
      document.body.appendChild(sidebarEl);
    }

    if (!document.getElementById('rs-styles')) {
      injectStyles();
    }
  }

  function mountSidebar() {
    if (!sidebarEl) {
      // Create a wrapper appended to body
      sidebarEl = document.createElement('div');
      sidebarEl.className = 'recent-subreddits-container';
      document.body.appendChild(sidebarEl);

      popupEl = buildPopupShell();
      sidebarEl.appendChild(popupEl);
      activeHotkey = parseHotkey(loadSettings().hotkey);

      renderContent(loadData());
    } else {
      ensureMounted();
    }

    // ---- Delegated listeners on the wrapper ----
    // One listener each, on nodes that are never rebuilt, so content re-renders
    // cannot drop them. stopPropagation keeps the document-level "click outside"
    // handler from closing the popup when one of its own controls is used.
    sidebarEl.addEventListener('click', (e) => {
      const pin = e.target.closest('.rs-pin-btn, .rs-unpin-btn');
      if (pin) {
        e.stopPropagation();
        togglePin(pin.dataset.name);
        return;
      }
      if (e.target.closest('.rs-close-btn')) {
        e.stopPropagation();
        togglePopup(false);
        return;
      }
      if (e.target.closest('.rs-settings-btn')) {
        e.stopPropagation();
        setSettingsOpen(!isSettingsOpen());
      }
      // Clicks anywhere else inside the popup are swallowed here so they cannot
      // reach the document handler and be read as an outside click.
      e.stopPropagation();
    });

    // Close popup when the pointer leaves it, with a grace period so the pointer
    // can travel from the trigger into the popup.
    sidebarEl.addEventListener('mouseleave', () => {
      setTimeout(() => {
        if (!isPopupVisible()) return;
        if (popupEl && !popupEl.matches(':hover')) togglePopup(false);
      }, 300);
    });

    // ---- Delegated triggers ----
    // Bound once, on `document`. `mouseover` bubbles (unlike `mouseenter`), so a
    // single listener covers every current and future trigger node, including
    // ones the host swaps in during SPA navigation.
    document.addEventListener('mouseover', (e) => {
      const trigger = e.target.closest && e.target.closest(TRIGGER_SELECTOR);
      if (!trigger) return;
      // Ignore movement *within* the trigger (children re-fire mouseover).
      if (e.relatedTarget && trigger.contains(e.relatedTarget)) return;
      togglePopup(true, trigger);
    });

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest && e.target.closest(TRIGGER_SELECTOR);
      if (trigger) {
        if (isPopupVisible()) {
          togglePopup(false);
        } else {
          e.preventDefault();
          togglePopup(true, trigger);
        }
        return;
      }

      // Click outside to close
      if (!isPopupVisible()) return;
      if (popupEl && !popupEl.contains(e.target)) {
        togglePopup(false);
      }
    });

    // ---- Keyboard ----
    document.addEventListener('keydown', (e) => {
      // The settings field handles its own keys and consumes them.
      if (e.target && e.target.id === 'rs-hotkey-input') return;

      if (e.key === 'Escape') {
        // Escape closes the settings modal first, then the popup.
        if (isSettingsOpen()) {
          setSettingsOpen(false);
          return;
        }
        togglePopup(false);
        return;
      }

      if (hotkeyMatches(e, activeHotkey)) {
        e.preventDefault();
        // The escape hatch: works with no trigger on the page at all.
        if (isPopupVisible()) togglePopup(false);
        else togglePopup(true);
      }
    });

    // Warn (once) if no trigger matched — the signature of a Reddit markup change.
    checkTriggers();
  }

  // ---------- SPA navigation detection ----------
  function observeNavigation() {
    let lastUrl = window.location.href;

    const observer = new MutationObserver(() => {
      // The host may have swapped our wrapper (or the <style>) out from under us.
      ensureMounted();

      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        const subName = getSubredditFromUrl();
        if (subName) {
          trackVisit(subName);
        }
        renderContent(loadData());
        // The new view may have a header we do not recognise.
        checkTriggers();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ---------- Init ----------
  function init() {
    injectStyles();

    // Track the current page
    const subName = getSubredditFromUrl();
    if (subName) {
      trackVisit(subName);
    }

    mountSidebar();
    observeNavigation();
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
