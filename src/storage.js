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
    const data = {
      recent: Array.isArray(parsed.recent) ? parsed.recent : [],
      pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
    };
    // Apply the cap on read, not only on write. The write path trims, but a
    // hand-edited or seeded store can still be over the limit — and the render
    // layer trusts what it is handed, so without this an over-cap list would
    // paint in full. The trim is not persisted here: a read must not write, and
    // the next save of any kind stores the trimmed form anyway.
    return pruneRecent(data, loadSettings().maxRecent);
  } catch {
    return { recent: [], pinned: [] };
  }
}

export function saveData(data) {
  GM_setValue(STORAGE_KEY, JSON.stringify(data));
}

// The cap on history is user-configurable (settings.maxRecent), so the bounds
// live here rather than only in the panel: a hand-edited store must not be able
// to set a cap of 0 (an empty list with no explanation) or of 100000.
export const MIN_MAX_RECENT = 1;
export const MAX_MAX_RECENT = 200;

/**
 * Trim `data.recent` to the configured cap, in place.
 *
 * Pinned subreddits are exempt from the cap. A pinned row lives in the Pinned
 * section, but its timestamp is looked up from this list (pinned entries are
 * stored as plain names) — so slicing it away would leave the pinned row with no
 * time while the row itself stayed on screen. The list therefore holds up to
 * `maxRecent` unpinned entries plus one per pinned subreddit.
 *
 * Order is preserved: `recent` is newest-first, and the first `maxRecent`
 * unpinned entries are the ones kept.
 */
export function pruneRecent(data, maxRecent) {
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
  // Opt-in: a tidy list by default, with each row's pin/trash (and the panel's
  // close button) appearing only while its row is hovered.
  hideRowControls: false,
  // Opt-out: show relative timestamps by default; uncheck to hide them.
  showTimestamps: true,
  // How many visited subreddits history keeps. The list is trimmed to this on
  // every visit, so lowering it also prunes what is already stored.
  maxRecent: MAX_RECENT,
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

/**
 * The history cap, clamped to a sane range.
 *
 * `null`, an empty string and a non-numeric string all fall back to the default
 * rather than to a value that would empty the list. The check is explicit
 * because `Number(null)` and `Number('')` are both 0, which would otherwise
 * resolve to the minimum instead of the default.
 *
 * Exported so the settings panel writes a clamped value rather than storing junk
 * and relying on the read path to tidy it up.
 */
export function clampMaxRecent(raw) {
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && raw.trim()) n = Number(raw);
  else return DEFAULT_SETTINGS.maxRecent;

  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.maxRecent;
  const int = Math.floor(n);
  if (int < MIN_MAX_RECENT) return MIN_MAX_RECENT;
  if (int > MAX_MAX_RECENT) return MAX_MAX_RECENT;
  return int;
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
      // Strict boolean: anything else (a hand-edited "true" string, a null)
      // falls back to the default rather than becoming truthy by accident.
      hideRowControls: parsed.hideRowControls === true,
      showTimestamps: parsed.showTimestamps !== false,
      maxRecent: clampMaxRecent(parsed.maxRecent),
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
