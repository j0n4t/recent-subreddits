// Storage: the visit list, the settings, and the hook-target lookup.
//
// Everything here goes through the Tampermonkey store via GM_getValue/GM_setValue,
// and every read is defensive: a hand-edited or truncated store must degrade to
// defaults, never throw.
import { BUILTIN_HOOK } from './defaults.js';

// ---------- Visits ----------
const STORAGE_KEY = 'recentSubreddits';
export const MAX_RECENT = 15;

export function loadData() {
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

export function saveData(data) {
  GM_setValue(STORAGE_KEY, JSON.stringify(data));
}

// ---------- Icons ----------
// Icons already resolved — harvested off a subreddit page, or fetched — are kept
// across page loads.
//
// This is what makes the harvest pay off. The icon cache is in memory, so
// without persistence it dies with every navigation and the next page re-fetches
// every row it had already resolved (measured: 26 about.json requests across six
// page loads, with the same four subreddits re-fetched on each one). Persisting
// turns the fetch into the soft fallback it is meant to be: it runs only for a
// subreddit whose icon has never been seen.
const ICONS_KEY = 'recentSubredditsIcons';
// The recent list is capped at MAX_RECENT, so this only matters after a long
// session over many subreddits.
const MAX_ICONS = 200;

export function loadIcons() {
  try {
    const raw = GM_getValue(ICONS_KEY, null);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, url] of Object.entries(parsed)) {
      if (typeof name === 'string' && name && typeof url === 'string' && url) out[name] = url;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveIcons(icons) {
  try {
    const entries = Object.entries(icons);
    const trimmed = entries.length > MAX_ICONS ? entries.slice(-MAX_ICONS) : entries;
    GM_setValue(ICONS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
  } catch {
    // A full or unavailable store must never break rendering: the icons are
    // still correct for this page load.
  }
}

// ---------- Settings ----------
const SETTINGS_KEY = 'recentSubredditsSettings';

// The escape hatch: a shortcut that opens the popup without depending on any
// Reddit selector. If the header markup changes and the logo stops matching,
// this still works, so a markup change degrades the feature instead of killing it.
//
// `targets` holds the built-in Reddit trigger, so the defaults ARE the working
// configuration: a first run starts with hover working, and "reset to defaults"
// puts that trigger back rather than leaving the user with nothing.
export const DEFAULT_SETTINGS = {
  hotkey: 'Alt+Shift+R',
  targets: [BUILTIN_HOOK],
  blocked: [],
};

/**
 * A fresh copy of the defaults. Callers must never mutate the module-level
 * object — its `targets` array would be shared by every reader.
 */
export function defaultSettings() {
  return {
    ...DEFAULT_SETTINGS,
    targets: DEFAULT_SETTINGS.targets.map((t) => ({ ...t })),
    blocked: [],
  };
}

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

/**
 * The blacklist: subreddits the user removed from history. A blocked subreddit
 * is never tracked again, so it cannot reappear in the list — the only way back
 * is to un-block it in settings. Normalized here so a hand-edited store cannot
 * put junk in it.
 */
function normalizeBlocked(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const name of raw) {
    if (typeof name !== 'string') continue;
    const n = name.trim().toLowerCase();
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function loadSettings() {
  try {
    const raw = GM_getValue(SETTINGS_KEY, null);
    // First run: nothing stored yet, so persist the defaults (hotkey + the
    // built-in popup trigger). Seeding here is what makes the trigger a real,
    // visible, removable settings entry rather than a hidden fallback.
    if (!raw) {
      const seeded = defaultSettings();
      saveSettings(seeded);
      return seeded;
    }
    const parsed = JSON.parse(raw);
    return {
      hotkey:
        typeof parsed.hotkey === 'string' && parsed.hotkey.trim()
          ? parsed.hotkey.trim()
          : DEFAULT_SETTINGS.hotkey,
      targets: normalizeTargets(parsed.targets),
      blocked: normalizeBlocked(parsed.blocked),
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(settings) {
  GM_setValue(SETTINGS_KEY, JSON.stringify(settings));
  // Invalidate the hook lookup — it is read on every mouseover.
  hookTargetsCache = null;
}

/**
 * Which hook targets the user configured, as `{selector, events}`. Cached
 * because this runs on every mouseover; saveSettings() invalidates it.
 */
export function hookTargets() {
  if (!hookTargetsCache) {
    hookTargetsCache = loadSettings().targets.filter((t) => t.mode === 'hook');
  }
  return hookTargetsCache;
}
