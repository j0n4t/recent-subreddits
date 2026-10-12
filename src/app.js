// The UI: everything that touches the DOM, plus init().
import { parseHotkey, hotkeyMatches, comboFromEvent } from './hotkey.js';
import { formatTimeAgo } from './time.js';

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
    const entry = {
      selector: t.selector.trim(),
      mode: TARGET_MODES.includes(t.mode) ? t.mode : 'hook',
      events: TARGET_EVENTS.includes(t.events) ? t.events : 'both',
    };
    // Preserve a saved resize size if present.
    if (t.size && typeof t.size === 'object') {
      if (typeof t.size.width === 'string') entry.size = { ...entry.size, width: t.size.width };
      if (typeof t.size.maxHeight === 'string') entry.size = { ...entry.size, maxHeight: t.size.maxHeight };
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
  // Never target our own chrome: the popup, an inline block, or the picker hint.
  if (el.closest('#rs-popup, .rs-inline-host, #rs-picker-hint')) return;

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
  // Icons live in every mounted instance: the popup and any inline block.
  document.querySelectorAll('img.rs-icon').forEach((img) => {
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
  // Refresh every mounted instance, not just the popup.
  renderContent(data);
  refreshInlineInstances();
}

/** Re-render the list inside every mounted inline block. */
function refreshInlineInstances() {
  const data = loadData();
  for (const rec of inlineInstances.values()) {
    if (!document.body.contains(rec.host)) continue;
    renderContent(data, rec.host.querySelector('.rs-inline'));
  }
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
  popup.className = 'recent-subreddits-popup rs-instance';
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

  const settings = document.createElement('div');
  settings.className = 'rs-settings-panel';

  popup.append(header, content, settings);
  return popup;
}

/**
 * Render the recent/pinned list into one instance's content slot.
 * `instance` defaults to the popup; an inline target passes its own node.
 */
function renderContent(data, instance) {
  const host = instance || popupEl;
  if (!host) return;

  const content = host.querySelector('.rs-content');
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

/**
 * Render the settings panel body into one instance's settings slot.
 * `instance` defaults to the popup; an inline target passes its own node.
 */
function renderSettings(instance) {
  const host = instance || popupEl;
  if (!host) return;
  const panel = host.querySelector('.rs-settings-panel');
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
        <button class="rs-btn rs-btn-small" data-role="pick">Pick element…</button>
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

  const input = panel.querySelector('.rs-hotkey-input');

  const say = (msg, kind) => {
    // Re-query: renderSettings() rebuilds the panel, so a captured reference
    // goes stale and the message would land on a detached node.
    const el = panel.querySelector('.rs-status');
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
  // `host` (declared above) is the instance whose panel is being edited.
  // Settings can be opened from the popup OR from an inline block, so every
  // write re-renders that same host rather than assuming the popup.

  const updateTarget = (index, patch) => {
    const s = loadSettings();
    if (!s.targets[index]) return;
    Object.assign(s.targets[index], patch);
    saveSettings(s);
    renderSettings(host);
    // A mode change alters the row's controls, so the instance is rebuilt.
    if ('mode' in patch) applyTargets();
    const sel = panel.querySelector(`[data-role="mode"][data-index="${index}"]`);
    if (sel && 'mode' in patch) sel.focus();
  };

  panel.querySelector('[data-role="pick"]').addEventListener('click', (e) => {
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
        renderSettings(host);
        say(`Added ${selector}`);
      },
      () => {
        // Cancelled (Esc) or finished: bring the UI back either way.
        setSettingsOpen(true);
        if (wasOpen) togglePopup(true);
      }
    );
  });

  panel.querySelector('.rs-targets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="remove"]');
    if (!btn) return;
    e.stopPropagation();
    const s = loadSettings();
    s.targets.splice(Number(btn.dataset.index), 1);
    saveSettings(s);
    renderSettings(host);
    // A removed target may have been an inline one — tear its block down.
    applyTargets();
    say('Target removed.');
  });

  panel.querySelector('.rs-targets').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role="mode"], [data-role="events"]');
    if (!sel) return;
    e.stopPropagation();
    const index = Number(sel.dataset.index);
    const role = sel.dataset.role;
    updateTarget(index, role === 'mode' ? { mode: sel.value } : { events: sel.value });
    say('Target updated.');
  });

  panel.querySelector('[data-role="reset"]').addEventListener('click', (e) => {
    e.stopPropagation();
    saveSettings({ ...DEFAULT_SETTINGS });
    activeHotkey = parseHotkey(DEFAULT_SETTINGS.hotkey);
    // Reset clears the targets too, so the inline blocks must go.
    applyTargets();
    renderSettings(host);
    say(`Reset to ${DEFAULT_SETTINGS.hotkey}.`);
  });

  panel.querySelector('[data-role="done"]').addEventListener('click', (e) => {
    e.stopPropagation();
    setSettingsOpen(false);
  });
}

// ---------- Inline instances (replace / prepend / append) ----------
// Each inline target gets a full instance of the UI — header, list, settings —
// built from the same shell as the popup, minus the popup-only chrome. The
// block is inserted NEXT TO the picked element rather than inside it, and the
// element is hidden with visibility (not display/remove) so the host's own
// layout, event handlers and framework references stay intact.
const inlineInstances = new Map(); // selector -> { el, host, mode }

const INLINE_MODES = ['replace', 'prepend', 'append'];

function buildInlineInstance(target) {
  const inst = buildPopupShell();

  // Inline blocks are always visible and are not a popup: drop the popup's
  // classes and positioning, but keep the shared instance class that carries
  // the content/settings swap rules.
  inst.classList.remove('recent-subreddits-popup');
  inst.classList.add('rs-inline', 'rs-instance');
  inst.removeAttribute('id');
  inst.classList.remove('visible');
  // The close button's job here is to drop the binding, not to hide a popup.
  const close = inst.querySelector('.rs-close-btn');
  if (close) close.title = 'Remove this binding';

  // The inline block has no anchor, so a hotkey-positioned popup is irrelevant.
  return inst;
}

/** Copy the host element's box so a replace keeps the page's layout. */
function matchElementBox(inst, el) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  // Only adopt a real size — a hidden or zero-height element must not collapse
  // the block to nothing.
  if (rect.width > 0) {
    inst.style.width = rect.width + 'px';
    inst.style.maxWidth = '100%';
  }
  // Keep it from inheriting the host's own typography or colour rules.
  if (cs.fontSize) inst.style.fontSize = cs.fontSize;

  // Absorb the host element's positioning so a sticky/fixed replacement
  // sticks the same way the original did.
  if (cs.position !== 'static') {
    inst.style.position = cs.position;
    if (cs.top !== 'auto') inst.style.top = cs.top;
    if (cs.right !== 'auto') inst.style.right = cs.right;
    if (cs.bottom !== 'auto') inst.style.bottom = cs.bottom;
    if (cs.left !== 'auto') inst.style.left = cs.left;
    if (cs.zIndex !== 'auto') inst.style.zIndex = cs.zIndex;
  }
  if (cs.margin !== '0px') inst.style.margin = cs.margin;
  if (cs.boxSizing) inst.style.boxSizing = cs.boxSizing;
}

/** Mount (or refresh) one inline instance for a target. */
function mountInlineInstance(target) {
  const { selector, mode } = target;

  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return; // a hand-typed selector may be invalid
  }
  if (!el) return; // nothing on this page matches; nothing to do

  let rec = inlineInstances.get(selector);

  // Rebuild when the mode changed or the block was detached by the host.
  if (rec && (rec.mode !== mode || !document.body.contains(rec.host))) {
    rec.host.remove();
    rec = null;
  }

  if (!rec) {
    const inst = buildInlineInstance(target);
    const host = document.createElement('div');
    host.className = 'rs-inline-host' + (mode === 'replace' ? ' rs-inline-host-replace' : '');
    host.dataset.rsSelector = selector;
    host.appendChild(inst);

    // Add a resize handle so the user can adjust the block size.
    const handle = document.createElement('div');
    handle.className = 'rs-resize-handle';
    host.appendChild(handle);

    // Placement relative to the picked element.
    if (mode === 'replace') {
      // Nest inside the element and overlap it — avoids leaving a gap
      // in the document flow where the hidden element used to be.
      el.style.visibility = 'hidden';
      el.appendChild(host);
    } else if (mode === 'prepend') {
      el.insertBefore(host, el.firstChild);
    } else {
      el.appendChild(host);
    }

    if (mode === 'replace') matchElementBox(inst, el);

    // Restore a previously saved size.
    if (target.size) {
      if (target.size.width) inst.style.width = target.size.width;
      if (target.size.height) inst.style.maxHeight = target.size.height;
    }

    rec = { el, host, mode };
    inlineInstances.set(selector, rec);
    wireInlineInstance(rec, target);
  }

  renderContent(loadData(), rec.host.querySelector('.rs-inline'));
}

/** Wire the resize handle so the user can drag the block to a new size. */
function wireResizeHandle(rec, target) {
  const handle = rec.host.querySelector('.rs-resize-handle');
  const inst = rec.host.querySelector('.rs-inline');
  if (!handle || !inst) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = inst.offsetWidth;
    const startH = inst.offsetHeight;

    const onMove = (ev) => {
      const newW = Math.max(80, startW + ev.clientX - startX);
      const newH = Math.max(60, startH + ev.clientY - startY);
      inst.style.width = newW + 'px';
      inst.style.maxHeight = newH + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist the new size so it survives re-mounts.
      const s = loadSettings();
      const t = s.targets.find((t) => t.selector === target.selector);
      if (t) {
        t.size = { width: inst.style.width, maxHeight: inst.style.maxHeight };
        saveSettings(s);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** Delegated handlers for one inline block. */
function wireInlineInstance(rec, target) {
  const inst = rec.host.querySelector('.rs-inline');
  if (!inst) return;

  wireResizeHandle(rec, target);

  // Pin/unpin, close (unbind), settings toggle — same behaviour as the popup,
  // but scoped to this block and with no popup to open or close.
  inst.addEventListener('click', (e) => {
    const pin = e.target.closest('.rs-pin-btn, .rs-unpin-btn');
    if (pin) {
      e.stopPropagation();
      togglePin(pin.dataset.name);
      return;
    }
    if (e.target.closest('.rs-close-btn')) {
      e.stopPropagation();
      // The close button removes this binding instead of closing a popup.
      removeTargetBySelector(target.selector);
      return;
    }
    if (e.target.closest('.rs-back-btn')) {
      e.stopPropagation();
      setSettingsOpen(false, inst);
      return;
    }
    if (e.target.closest('.rs-settings-btn')) {
      e.stopPropagation();
      setSettingsOpen(!inst.classList.contains('settings-open'), inst);
    }
    // Keep clicks inside the block from reaching the document handlers, which
    // would read them as an outside click and close the popup.
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

/**
 * Reconcile the DOM with the configured inline targets: mount what is missing,
 * tear down what is no longer configured, and unhide elements we had hidden.
 * Safe to call after any settings write or navigation.
 */
function applyTargets() {
  if (!document.body) return;
  const wanted = loadSettings().targets.filter((t) => INLINE_MODES.includes(t.mode));

  // Tear down instances whose target is gone or whose mode left the inline set.
  for (const [selector, rec] of Array.from(inlineInstances.entries())) {
    const stillWanted = wanted.some((t) => t.selector === selector);
    if (!stillWanted) {
      // Un-hide the element we replaced, or it stays invisible forever.
      if (rec.el && rec.el.style.visibility === 'hidden') rec.el.style.visibility = '';
      rec.host.remove();
      inlineInstances.delete(selector);
    }
  }

  for (const t of wanted) mountInlineInstance(t);
}

function setSettingsOpen(open, instance) {
  const host = instance || popupEl;
  if (!host) return;

  // Only the popup tracks this flag; an inline block's panel is toggled by
  // its own gear and never blocks the global Escape handling.
  if (host === popupEl) settingsOpen = open;

  host.classList.toggle('settings-open', open);
  const title = host.querySelector('.rs-header');
  if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
  if (open) renderSettings(host);
}

// Kept in a module-level variable so the hotkey can change without rebinding.
let activeHotkey = null;

// The element the popup is currently anchored to, so it can be re-positioned
// without the caller having to pass the trigger again.
let lastTrigger = null;

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
    /* ---- Shared instance chrome ---- */
    /* The popup and the inline blocks are the same UI in two containers, so
       the view-swap rules key off a shared class rather than the popup's. */
    .rs-instance.settings-open .rs-content { display: none; }
    .rs-instance.settings-open .rs-settings-panel { display: block; }
    .rs-instance.settings-open .rs-back-btn { display: block; }
    /* The gear is redundant next to the "⚙ Settings" title; back is the way out. */
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
       re-declares them here — otherwise every var() resolves to nothing and
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
      /* Hardcoded grey — visible on both light and dark backgrounds.
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
    // Mount any configured inline blocks on this page.
    applyTargets();
  } else {
    ensureMounted();
    applyTargets();
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
    if (e.target && e.target.classList && e.target.classList.contains('rs-hotkey-input')) return;

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
      // The new view replaced the DOM: inline hosts may be gone, and the new
      // view may have elements matching targets that were absent before.
      // Only on a URL change — applyTargets() inserts nodes, and calling it on
      // every mutation would fight the observer's own trigger.
      applyTargets();
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
