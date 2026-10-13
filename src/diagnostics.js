// Diagnostics
//
// One warn per condition per page, so a broken selector is visible in the
// console without spamming it. Silent when everything matches, which is the
// normal case.

const warned = new Set();

function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[recent-subreddits] ${message}`);
}

/** How many elements a selector currently matches. 0 also covers an invalid one. */
function countMatches(selector) {
  try {
    return document.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
}

/**
 * Warn when the configured hooks match nothing on this page — the signature of a
 * Reddit markup change.
 *
 * The check is per configured hook, not against a hardcoded selector list: the
 * built-in Reddit trigger is an ordinary settings entry now, so it may have been
 * edited or deleted, and what matters is whether what the user actually has
 * matches. Two cases stay silent on purpose:
 *
 *   * no hooks configured at all — a deliberate choice, not a broken page (the
 *     popup is hotkey-only, and the settings panel says so);
 *   * at least one hook matches — the feature is reachable, which is all this
 *     diagnostic is about.
 */
export function checkTriggers(hookSelectors = []) {
  if (!hookSelectors.length) return;
  if (hookSelectors.some((s) => countMatches(s) > 0)) return;
  warnOnce(
    'triggers',
    `none of the configured hooks matched on this page ` +
    `(selectors: ${hookSelectors.join(', ')}). Hovering or clicking will not ` +
    `open the popup. Use the hotkey instead, and check the Page targets in ` +
    `settings — Reddit may have changed its markup.`
  );
}
