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

/**
 * Warn when the page should offer a harvestable icon and does not.
 *
 * The harvest is the cheap primary source: reddit renders the current
 * subreddit's own icon into the page, and reading it costs no request. If that
 * anchor is renamed, harvesting silently stops and every icon falls back to the
 * rate-limited about.json fetch — the user sees grey circles with nothing in the
 * console, which is the bug this repo already fixed once.
 *
 * Fires only when the page NAMES a subreddit but has no icon anchor. Those are
 * the harvest's own two signals, so no markup is guessed at, and the cases that
 * must stay silent do:
 *
 *   * old.reddit.com — matched by the script, but it has neither the header nor
 *     the anchor, so it never names a subreddit here;
 *   * the home feed and any non-subreddit route — nothing names a subreddit;
 *   * mid-navigation — the anchor is stale but PRESENT, so there is an icon;
 *   * a page that has not rendered its header yet — nothing names a subreddit.
 *
 * `signals` is `{ named, hasIcon }` from harvestSignals(), passed in rather than
 * read here so this stays a pure decision (and testable without a DOM).
 */
export function checkHarvest(signals) {
  if (!signals || !signals.named || signals.hasIcon) return;
  warnOnce(
    'harvest',
    `this page names a subreddit but has no #subreddit-icon-img anchor, so its ` +
    `icon cannot be harvested. Icons will fall back to /r/<name>/about.json, ` +
    `which reddit rate-limits — expect grey placeholders. Reddit may have ` +
    `changed its markup.`
  );
}
