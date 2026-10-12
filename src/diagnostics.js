// Diagnostics
//
// One warn per condition per page, so a broken selector is visible in the
// console without spamming it. Silent when everything matches, which is the
// normal case.

// Combined selector for every element that should trigger the popup.
// Used with Element.closest() so listeners can live on `document` instead of
// on the trigger nodes — the host re-renders its header on SPA navigation and
// would otherwise swap in replacement nodes that carry no listeners.
export const TRIGGER_SELECTOR = [
  'a[href="/"]',                       // Reddit logo link
  '#header-logo',                      // Old Reddit logo
  '.header-logo',                      // Alternative logo class
  '[data-testid="top-nav-logo"]',      // New Reddit logo
  'button[aria-label*="menu" i]',      // Menu button
  '#TopNav button',                    // Top nav button area
  '#reddit-logo',
  '#navbar-menu-button',
].join(', ');

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

export function checkTriggers() {
  if (countTriggers() > 0) return;
  warnOnce(
    'triggers',
    `no popup trigger matched on this page (selectors: ${TRIGGER_SELECTOR}). ` +
    `Hovering the logo will not open the popup. Use the hotkey instead, ` +
    `and report this so the selectors can be updated.`
  );
}
