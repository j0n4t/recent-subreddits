// Defaults
//
// The built-in Reddit trigger used to be a hardcoded fallback inside the trigger
// resolver, which meant it could not be seen or changed. It is a normal settings
// entry now: it appears in the Page targets list like anything the user picks,
// and deleting it really does remove it — the popup then only opens with the
// hotkey, which the settings panel points out.

// Every element that should open the popup on Reddit. Used with
// Element.closest() so listeners can live on `document` instead of on the
// trigger nodes — the host re-renders its header on SPA navigation and would
// otherwise swap in replacement nodes that carry no listeners.
//
// One combined selector rather than eight entries: they are all "the Reddit logo
// or the menu button", so they belong in one row.
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

/** The default popup trigger, as a settings target. */
export const BUILTIN_HOOK = {
  selector: TRIGGER_SELECTOR,
  mode: 'hook',
  events: 'both',
};
