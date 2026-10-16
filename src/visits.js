// Visit tracking and pinning
//
// The writes that change what the list shows. All re-render every mounted
// instance afterwards, which is why they take a `refresh` callback rather than
// importing the render layer themselves.
import { loadData, saveData, loadSettings, saveSettings, MAX_RECENT } from './storage.js';
export function getSubredditFromUrl() {
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

/** Whether `name` is blacklisted (removed from history and not restored). */
export function isBlocked(name) {
  return loadSettings().blocked.includes(String(name).toLowerCase());
}

/**
 * Record a visit.
 *
 * A blacklisted subreddit is deliberately NOT recorded: the user removed it from
 * history, and "never tracked again" is what that means. This is the single point
 * that enforces it, so it holds for both the initial page load and SPA
 * navigation.
 */
export function trackVisit(name) {
  if (isBlocked(name)) return;
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

/** Toggle a pin, then refresh every mounted instance. */
export function togglePin(name, refresh) {
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

/**
 * Move a pinned subreddit up or down in the order, then refresh every mounted
 * instance. No-op if the name is not pinned or the move would go out of bounds.
 */
export function movePinned(name, direction, refresh) {
  const data = loadData();
  const idx = data.pinned.indexOf(name);
  if (idx < 0) return;
  const swap = direction === 'up' ? idx - 1 : idx + 1;
  if (swap < 0 || swap >= data.pinned.length) return;
  [data.pinned[idx], data.pinned[swap]] = [data.pinned[swap], data.pinned[idx]];
  saveData(data);
  refresh(data);
}

/**
 * Remove a subreddit from history AND blacklist it, then refresh every mounted
 * instance.
 *
 * Both halves matter: dropping the row alone would let the very next visit put it
 * straight back, so the blacklist is what makes the removal stick. Only the
 * Recent list is touched — a pinned subreddit is not in `recent` anyway, and
 * unpinning is the pin button's job. No confirmation is asked for; history is
 * cheap to rebuild by un-blocking the subreddit in settings.
 *
 * The cached icon is deliberately left alone: it is a pure lookup keyed by name,
 * so a restore renders its icon with no fetch at all.
 */
export function removeVisit(name, refresh) {
  const key = String(name).toLowerCase();
  const data = loadData();
  data.recent = data.recent.filter((s) => s.name !== key);
  saveData(data);

  // Blacklist it, unless it is already there (so the list cannot accumulate
  // duplicates).
  const s = loadSettings();
  if (!s.blocked.includes(key)) {
    s.blocked.push(key);
    saveSettings(s);
  }

  refresh(data);
}
