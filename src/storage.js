// Storage: the visit list, the settings, and the hook-target lookup.
//
// Everything here goes through the Tampermonkey store via GM_getValue/GM_setValue,
// and every read is defensive: a hand-edited or truncated store must degrade to
// defaults, never throw.

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

// ---------- Settings ----------
const SETTINGS_KEY = 'recentSubredditsSettings';

// The escape hatch: a shortcut that opens the popup without depending on any
// Reddit selector. If the header markup changes and the logo stops matching,
// this still works, so a markup change degrades the feature instead of killing it.
export const DEFAULT_SETTINGS = { hotkey: 'Alt+Shift+R', targets: [] };

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

export function loadSettings() {
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
