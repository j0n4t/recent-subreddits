// Visit tracking and pinning
//
// The two writes that change what the list shows. Both re-render every mounted
// instance afterwards, which is why they take a `refresh` callback rather than
// importing the render layer themselves.
import { loadData, saveData, MAX_RECENT } from './storage.js';

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

export function trackVisit(name) {
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
