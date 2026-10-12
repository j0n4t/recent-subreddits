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
  const DEFAULT_SETTINGS = { hotkey: 'Alt+Shift+R', targets: [] };

  // Which page elements the user hooked, and how each one behaves.
  //   hook    — hovering/clicking it opens the popup
  //   replace / prepend / append — render the list inline at that spot
  // `events` only applies to `hook`: 'hover' | 'click' | 'both'.
  const TARGET_MODES = ['hook', 'replace', 'prepend', 'append'];
  const TARGET_EVENTS = ['hover', 'click', 'both'];

  // Hook targets are consulted on every mouseover, so they are cached and the
  // cache is dropped whenever settings are written.
  let hookTargetsCache = null;

  /** Drop anything malformed so a hand-edited store cannot break the script. */
  function normalizeTargets(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const t of raw) {
      if (!t || typeof t.selector !== 'string' || !t.selector.trim()) continue;
      out.push({
        selector: t.selector.trim(),
        mode: TARGET_MODES.includes(t.mode) ? t.mode : 'hook',
        events: TARGET_EVENTS.includes(t.events) ? t.events : 'both',
      });
    }
    return out;
  }

  function loadSettings() {
    try {
      const raw = GM_getValue(SETTINGS_KEY, null);
      if (!raw) return { hotkey: DEFAULT_SETTINGS.hotkey, targets: [] };
      const parsed = JSON.parse(raw);
      return {
        hotkey:
          typeof parsed.hotkey === 'string' && parsed.hotkey.trim()
            ? parsed.hotkey.trim()
            : DEFAULT_SETTINGS.hotkey,
        targets: normalizeTargets(parsed.targets),
      };
    } catch {
      return { hotkey: DEFAULT_SETTINGS.hotkey, targets: [] };
    }
  }

  function saveSettings(settings) {
    GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
    // Invalidate the hook lookup — it is read on every mouseover.
    hookTargetsCache = null;
  }

  // ---------- Selector builder ----------
  /**
   * Turn a picked element into a selector that survives a re-render as well as it
   * can. Priority: a stable id, then a data-testid, then an nth-of-type path.
   * Classes are deliberately NOT used alone — Reddit's build hashes them and they
   * change between deploys, which is the whole reason this feature exists.
   */
  function cssEscape(value) {
    const s = String(value);
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }

  /** A selector for `el`, preferring whatever is least likely to break. */
  function buildSelector(el) {
    if (!el || el.nodeType !== 1) return '';

    // 1. A usable id (auto-generated ids like ":r1:" are not stable).
    if (el.id && isUnique('#' + cssEscape(el.id))) {
      const id = '#' + cssEscape(el.id);
      if (id.length < 80) return id;
    }

    // 2. A test id — Reddit keeps these stable across builds.
    const testId = el.getAttribute('data-testid');
    if (testId) {
      const sel = `[data-testid="${cssEscape(testId)}"]`;
      if (isUnique(sel)) return sel;
    }

    // 3. An nth-of-type path, shortened by the nearest unique ancestor.
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

      const candidate = parts.join(' > ');
      // Stop as soon as the tail is unique on its own — keeps it short.
      if (isUnique(candidate)) return candidate;
      node = parent;
    }

    return parts.join(' > ');
  }

  // ---------- Element picker ----------
  // A live overlay: hovering the page outlines the element under the cursor, and
  // clicking it hands its selector back. The overlay swallows the click so the
  // host page never sees it (no navigation, no Reddit handler firing).
  const PICKER_STYLE_ID = 'rs-picker-styles';

  let pickerActive = false;
  let pickerBox = null;
  let pickerHovered = null;
  let pickerOnPick = null;
  let pickerOnEnd = null;

  function pickerHintEl() {
    return document.getElementById('rs-picker-hint');
  }

  function pickerCleanup() {
    const hint = pickerHintEl();
    if (hint) hint.remove();
    document.removeEventListener('mousemove', pickerMove, true);
    document.removeEventListener('click', pickerClick, true);
    document.removeEventListener('keydown', pickerKey, true);
    document.removeEventListener('scroll', pickerMove, true);
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
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    // Never target our own chrome.
    if (el.closest('#rs-popup, #rs-picker-hint')) return;

    pickerHovered = el;
    const rect = el.getBoundingClientRect();
    const box = pickerBox;
    box.style.display = 'block';
    box.style.top = rect.top + 'px';
    box.style.left = rect.left + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';

    const hint = pickerHintEl();
    if (hint) {
      hint.textContent = `${buildSelector(el)}  —  click to use, Esc to cancel`;
    }
  }

  function pickerClick(e) {
    if (!pickerActive) return;
    // Swallow the click: the host must not act on a pick.
    e.preventDefault();
    e.stopPropagation();
    const el = pickerHovered;
    const selector = el ? buildSelector(el) : '';
    const onPick = pickerOnPick;
    pickerCleanup();
    if (selector && onPick) onPick(selector);
  }

  function pickerKey(e) {
    if (!pickerActive) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      pickerCleanup();
    }
  }

  /** Start picking. `onPick(selector)` fires on a click, `onEnd()` on any exit. */
  function startPicker(onPick, onEnd) {
    if (pickerActive) pickerCleanup();

    if (!document.getElementById(PICKER_STYLE_ID)) {
      const style = document.createElement('style');
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

    const box = document.createElement('div');
    box.id = 'rs-picker-box';
    document.body.appendChild(box);

    const hint = document.createElement('div');
    hint.id = 'rs-picker-hint';
    hint.textContent = 'Hover an element and click it — Esc to cancel';
    document.body.appendChild(hint);

    pickerBox = box;
    pickerHovered = null;
    pickerOnPick = onPick;
    pickerOnEnd = onEnd;
    pickerActive = true;

    // Capture phase so the host's own handlers never see the pick.
    document.addEventListener('mousemove', pickerMove, true);
    document.addEventListener('click', pickerClick, true);
    document.addEventListener('keydown', pickerKey, true);
    document.addEventListener('scroll', pickerMove, true);
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
  // Header label per view: icon + title, swapped when the settings panel opens.
  const HEADER_TITLE = { main: '📋 Recent Subreddits', settings: '⚙ Settings' };

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
    title.textContent = HEADER_TITLE.main;

    const back = document.createElement('button');
    back.className = 'rs-back-btn';
    back.id = 'rs-back';
    back.title = 'Back';
    back.textContent = '←';

    const gear = document.createElement('button');
    gear.className = 'rs-settings-btn';
    gear.id = 'rs-settings';
    gear.title = 'Settings';
    gear.textContent = '⚙';

    header.append(back, title, gear, close);

    const content = document.createElement('div');
    content.className = 'rs-content';
    content.id = 'rs-content';

    const settings = document.createElement('div');
    settings.className = 'rs-settings-panel';
    settings.id = 'rs-settings-panel';

    popup.append(header, content, settings);
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

    const modeOptions = (selected) =>
      [
        ['hook', 'Hook (open popup)'],
        ['replace', 'Replace element'],
        ['prepend', 'Prepend inside'],
        ['append', 'Append inside'],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
        )
        .join('');

    const eventOptions = (selected) =>
      [
        ['both', 'Hover + click'],
        ['hover', 'Hover only'],
        ['click', 'Click only'],
      ]
        .map(
          ([value, label]) =>
            `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
        )
        .join('');

    const targetRows = settings.targets.length
      ? settings.targets
          .map((t, i) => {
            // Events only mean something for a hook target.
            const eventsCell =
              t.mode === 'hook'
                ? `<select class="rs-select" data-role="events" data-index="${i}">${eventOptions(t.events)}</select>`
                : `<span class="rs-muted">—</span>`;
            return `
              <li class="rs-target">
                <code class="rs-target-sel" title="${escAttr(t.selector)}">${escAttr(t.selector)}</code>
                <div class="rs-target-controls">
                  <select class="rs-select" data-role="mode" data-index="${i}">${modeOptions(t.mode)}</select>
                  ${eventsCell}
                  <button class="rs-icon-btn" data-role="remove" data-index="${i}" title="Remove">✕</button>
                </div>
              </li>`;
          })
          .join('')
      : '<li class="rs-empty">No page targets yet.</li>';

    panel.innerHTML = `
      <div class="rs-field">
        <label class="rs-label" for="rs-hotkey-input">Open popup hotkey</label>
        <input class="rs-input" id="rs-hotkey-input" type="text" readonly
               value="${escAttr(settings.hotkey)}"
               placeholder="Click and press a combination" />
        <div class="rs-hint">Click the field, then press the keys you want.
          Use at least one modifier (Ctrl / Alt / Shift / Meta).</div>
      </div>

      <div class="rs-field">
        <div class="rs-label-row">
          <label class="rs-label">Page targets</label>
          <button class="rs-btn rs-btn-small" id="rs-pick">Pick element…</button>
        </div>
        <div class="rs-hint">Pick an element on the page, then choose what it does.
          A hook opens the popup; the others render the list inline there.</div>
        <ul class="rs-targets" id="rs-targets">${targetRows}</ul>
      </div>

      <div class="rs-status" id="rs-status"></div>
      <div class="rs-actions">
        <button class="rs-btn" id="rs-reset">Reset to default</button>
        <button class="rs-btn rs-btn-primary" id="rs-done">Done</button>
      </div>
    `;

    const input = panel.querySelector('#rs-hotkey-input');

    const say = (msg, kind) => {
      // Re-query: renderSettings() rebuilds the panel, so a captured reference
      // goes stale and the message would land on a detached node.
      const el = panel.querySelector('#rs-status');
      if (!el) return;
      el.textContent = msg;
      el.className = 'rs-status ' + (kind === 'error' ? 'rs-status-error' : 'rs-status-ok');
    };

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
        say('Press a key along with at least one modifier.', 'error');
        return;
      }

      // Require a modifier: a bare letter would fire while the user is typing in
      // Reddit's own search box.
      if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        say('Add a modifier (Ctrl / Alt / Shift / Meta).', 'error');
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
      say(`Saved — press ${combo} to open the popup.`);
    });

    // ---- Target list ----
    const updateTarget = (index, patch) => {
      const s = loadSettings();
      if (!s.targets[index]) return;
      Object.assign(s.targets[index], patch);
      saveSettings(s);
      renderSettings();
      // Re-focus the control the user was using, so a mode change is not a dead end.
      const sel = panel.querySelector(`[data-role="mode"][data-index="${index}"]`);
      if (sel && 'mode' in patch) sel.focus();
    };

    panel.querySelector('#rs-pick').addEventListener('click', (e) => {
      e.stopPropagation();
      // Close the popup so the whole page is pickable, then re-open settings after.
      const wasOpen = isPopupVisible();
      if (wasOpen) togglePopup(false);

      startPicker(
        (selector) => {
          // onEnd() has already restored the UI by the time this runs.
          const s = loadSettings();
          if (s.targets.some((t) => t.selector === selector)) {
            // Re-picking an element that is already configured is a no-op.
            say('That element is already in the list.', 'error');
            return;
          }
          s.targets.push({ selector, mode: 'hook', events: 'both' });
          saveSettings(s);
          renderSettings();
          say(`Added ${selector}`);
        },
        () => {
          // Cancelled (Esc) or finished: bring the UI back either way.
          setSettingsOpen(true);
          if (wasOpen) togglePopup(true);
        }
      );
    });

    panel.querySelector('#rs-targets').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-role="remove"]');
      if (!btn) return;
      e.stopPropagation();
      const s = loadSettings();
      s.targets.splice(Number(btn.dataset.index), 1);
      saveSettings(s);
      renderSettings();
      const s2 = panel.querySelector('#rs-status');
      s2.textContent = 'Target removed.';
      s2.className = 'rs-status rs-status-ok';
    });

    panel.querySelector('#rs-targets').addEventListener('change', (e) => {
      const sel = e.target.closest('[data-role="mode"], [data-role="events"]');
      if (!sel) return;
      e.stopPropagation();
      const index = Number(sel.dataset.index);
      const role = sel.dataset.role;
      updateTarget(index, role === 'mode' ? { mode: sel.value } : { events: sel.value });
      const s2 = panel.querySelector('#rs-status');
      s2.textContent = 'Target updated.';
      s2.className = 'rs-status rs-status-ok';
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
    const title = popupEl.querySelector('.rs-header');
    if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
    if (open) renderSettings();
  }

  // Kept in a module-level variable so the hotkey can change without rebinding.
  let activeHotkey = null;

  // The element the popup is currently anchored to, so it can be re-positioned
  // without the caller having to pass the trigger again.
  let lastTrigger = null;

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
      .rs-back-btn:hover { color: var(--rs-text); }
      .recent-subreddits-popup.settings-open .rs-back-btn { display: block; }
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
      /* The gear is redundant next to the "⚙ Settings" title; back is the way out. */
      .recent-subreddits-popup.settings-open .rs-settings-btn { display: none; }
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
      // Remember the anchor so re-opening after a pick lands in the same place
      // instead of snapping to the centre.
      if (trigger) lastTrigger = trigger;
      popupEl.classList.add('visible');
      if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(lastTrigger);
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

  /**
   * Which hook targets the user configured, as `{selector, events}`. Cached
   * because this runs on every mouseover; saveSettings() invalidates it.
   */
  function hookTargets() {
    if (!hookTargetsCache) {
      hookTargetsCache = loadSettings().targets.filter((t) => t.mode === 'hook');
    }
    return hookTargetsCache;
  }

  /**
   * Resolve an event target to `{el, events}` if it is a popup trigger, else null.
   * A user hook wins over the built-in selectors so its own event choice applies.
   */
  function resolveTrigger(target) {
    if (!target || typeof target.closest !== 'function') return null;

    for (const t of hookTargets()) {
      let el;
      try {
        el = target.closest(t.selector);
      } catch {
        // A selector the user typed by hand may be invalid — ignore it.
        continue;
      }
      if (el) return { el, events: t.events };
    }

    const builtin = target.closest(TRIGGER_SELECTOR);
    // The stock logo triggers keep the original behaviour: hover and click.
    if (builtin) return { el: builtin, events: 'both' };

    return null;
  }

  const wantsHover = (events) => events === 'hover' || events === 'both';
  const wantsClick = (events) => events === 'click' || events === 'both';

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
      if (e.target.closest('.rs-back-btn')) {
        e.stopPropagation();
        setSettingsOpen(false);
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
      const hit = resolveTrigger(e.target);
      if (!hit || !wantsHover(hit.events)) return;
      // Ignore movement *within* the trigger (children re-fire mouseover).
      if (e.relatedTarget && hit.el.contains(e.relatedTarget)) return;
      togglePopup(true, hit.el);
    });

    document.addEventListener('click', (e) => {
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
      // A click-only target's click must not fall through to "close the popup".
      if (hit) return;

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
