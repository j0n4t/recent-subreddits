// Subreddit icons
//
// Two ways to learn a subreddit's icon, in this order:
//
//   1. HARVEST. Reddit renders the current subreddit's own icon into the page
//      (`#subreddit-icon-img`, verified on the live site: it holds that
//      subreddit's communityIcon and the image is already in cache). Reading it
//      costs nothing, so it is the primary source.
//   2. FETCH `/r/<name>/about.json`. This is the expensive fallback, and it is
//      unreliable: reddit answers it with a 403 and an HTML "blocked by network
//      security" page — per-subreddit and time-varying (measured: two of twelve
//      subreddits 403 on every attempt while their neighbours succeed, and the
//      same subreddit 403s in one run and returns 200 in the next). So it is
//      tried a few times and then left alone; a row that stays unresolved is
//      picked up by the harvest the next time that subreddit is opened.
//
// A failure is therefore never cached as settled. Only a real icon URL is
// cached; a failed fetch is remembered just long enough to back off.
import { loadIcons, saveIcons } from './storage.js';

export const DEFAULT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";

// How many times one subreddit's icon is fetched before the fetch is left
// alone. Deliberately few: the harvest is the real recovery path, so there is
// no value in hammering an endpoint that is rate-limiting us.
export const ICON_MAX_ATTEMPTS = 3;
// Delay before each retry (index 0 = the first retry).
export const ICON_RETRY_DELAYS = [800, 2000];
// Spacing between the starts of consecutive fetches across subreddits.
export const ICON_REQUEST_GAP = 120;
// Once the attempt cap is hit, wait this long before fetching that subreddit
// again. Measured: the set of subreddits reddit 403s changes from run to run and
// holds for a whole session, so a row blocked now may answer minutes later.
export const ICON_FAILURE_RESET = 5 * 60_000;
// A harvested or fetched icon URL always comes from reddit's image CDN. Checked
// so a stray <img> in the page can never be adopted as a subreddit's icon.
const ICON_HOST = /^https:\/\/[a-z0-9.-]*\.?redditmedia\.com\//i;


// name -> icon URL. Seeded from the persistent store, so an icon resolved on an
// earlier page load is never fetched again. Only ever holds a SUCCESS: a failed
// lookup must not be readable here, or a caller would treat the grey placeholder
// as final.
const iconCache = loadIcons();
// name -> { attempts, nextTryAt, firstFailedAt }. Bookkeeping for a subreddit
// whose fetch has not succeeded yet; dropped as soon as one does.
const iconFailures = {};
// icon URL -> the subreddit it belongs to. A given icon URL identifies exactly
// one community, so this is what makes a stale read detectable.
const iconUrlOwner = {};
// Names queued or currently in flight, so one name is never requested twice.
const iconQueue = [];
const iconInFlight = new Set();
let iconPumpRunning = false;

/** The icon cached for `name`, or the placeholder. Never triggers a fetch. */
export function cachedIcon(name) {
  return iconCache[name] || DEFAULT_ICON;
}

/**
 * Read the icon URL of the subreddit currently open in the page.
 *
 * Reddit renders it as an `<img>` inside `#subreddit-icon-img`, so this is a DOM
 * read with no request behind it — which is how reddit's own recent-communities
 * list gets its icons (traced live: opening it issues zero about.json requests).
 *
 * Returns null when the page is not a subreddit view, or the icon has not been
 * rendered yet. That is the normal, expected outcome on most pages.
 */
function readCurrentSubredditIcon() {
  const el = document.getElementById('subreddit-icon-img');
  if (!el) return null;

  const img = el.tagName === 'IMG' ? el : el.querySelector('img');
  let src = img ? img.getAttribute('src') : null;

  // Some communities carry their icon as a background image instead.
  if (!src) {
    const carrier = el.querySelector('[style*="background-image"]') || el;
    const style = carrier.getAttribute && carrier.getAttribute('style');
    const bg = style ? /url\(["']?(.*?)["']?\)/.exec(style) : null;
    if (bg) src = bg[1];
  }

  if (!src || !ICON_HOST.test(src)) return null;
  return src;
}

/**
 * Which subreddit this page is showing, from the page itself.
 *
 * `shreddit-subreddit-header` carries `name` (and `subreddit-id`) for the
 * community reddit is displaying, and the icon anchor is rendered by that same
 * component — so the header names the subreddit the anchor's icon actually
 * belongs to.
 *
 * It is targeted specifically, not as a bare `[name]`: the home feed is full of
 * `shreddit-join-button[name]` elements naming the posts' communities, which a
 * loose query would happily return.
 *
 * The URL is deliberately NOT used as a fallback. Measured on live reddit: after
 * a subreddit-to-subreddit navigation the URL is already the new route while the
 * anchor still holds the PREVIOUS subreddit's icon for ~1s, so naming by the URL
 * would file one subreddit's icon under another's. The header has no such
 * window, and when it is absent there is nothing authoritative to file the icon
 * under — so the harvest declines and the fetch fallback handles it.
 */
function currentSubredditName() {
  const header = document.querySelector('shreddit-subreddit-header[name]');
  if (!header) return null;
  const name = (header.getAttribute('name') || '').trim().toLowerCase();
  return name || null;
}

/** Record a resolved icon and patch it into every mounted list. */
function recordIcon(name, icon, isMounted) {
  iconCache[name] = icon;
  // Claim the URL for this subreddit. Two rows can never share an icon URL, so
  // this is what stops a stale anchor from filing one subreddit's icon under
  // another's name.
  iconUrlOwner[icon] = name;
  delete iconFailures[name];
  // Persist immediately: the next page load must not re-fetch this. A fetch or
  // harvest that resolved an icon is a one-time cost, not a per-page one.
  saveIcons(iconCache);
  updateIconInDom(name, icon, isMounted);
}

/**
 * What the page currently offers the harvest, as two independent signals.
 *
 * Exposed for the diagnostic rather than the harvest itself. A new-Reddit
 * subreddit page names itself in a header AND carries an icon anchor; old Reddit
 * and the home feed carry neither. Keeping the two separate is what lets a caller
 * tell "this page has no harvestable icon" (normal, and silent) from "this page
 * should have one and it is gone" (a markup change, worth a warning) — the
 * distinction a single "did the harvest work" flag would lose.
 */
export function harvestSignals() {
  return { named: !!currentSubredditName(), hasIcon: !!readCurrentSubredditIcon() };
}

/**
 * Adopt the current subreddit's icon from the page, if it is showing one.
 *
 * Returns true when an icon was adopted. Deliberately conservative — each guard
 * exists because of a measured way the read can go wrong:
 *
 *   * no anchor, or a non-redditmedia URL: nothing to adopt.
 *   * no subreddit header: nothing authoritative names the icon, so decline and
 *     let the fetch fallback handle it.
 *   * the URL is already claimed by a different subreddit: refuse. Two rows can
 *     never legitimately share an icon URL, so this makes a stale read harmless
 *     even if the naming signals somehow agree.
 */
export function harvestCurrentSubredditIcon(isMounted) {
  const icon = readCurrentSubredditIcon();
  if (!icon) return false;

  const name = currentSubredditName();
  if (!name) return false;

  const owner = iconUrlOwner[icon];
  if (owner && owner !== name) return false;

  // Already settled with the same URL: nothing to do, and no DOM churn.
  if (iconCache[name] === icon) return false;

  recordIcon(name, icon, isMounted);
  return true;
}

/**
 * Patch a late-arriving icon into the DOM, wherever it is mounted.
 * `isMounted()` gates the work: with nothing mounted there is no list to patch.
 */
function updateIconInDom(name, icon, isMounted) {
  if (!isMounted() || !icon) return;
  const encoded = encodeURIComponent(name);
  // Icons live in every mounted instance: the popup and any inline block.
  /** @type {NodeListOf<HTMLImageElement>} */
  const icons = document.querySelectorAll('img.rs-icon');
  icons.forEach((img) => {
    if (img.dataset.name === encoded) img.src = icon;
  });
}

/** Remember a failure and let its cooldown expire before the next attempt. */
function recordFailure(name, isMounted) {
  const prev = iconFailures[name];
  const attempts = (prev ? prev.attempts : 0) + 1;
  const delay =
    ICON_RETRY_DELAYS[attempts - 1] ?? ICON_RETRY_DELAYS[ICON_RETRY_DELAYS.length - 1];
  iconFailures[name] = {
    attempts,
    nextTryAt: Date.now() + delay,
    firstFailedAt: prev ? prev.firstFailedAt : Date.now(),
  };

  // Self-scheduling recovery. Waiting for the next render to retry is not
  // enough: with the popup already open nothing re-renders, so a transient 403
  // would still leave the row grey until the user did something. The timer
  // re-queues the name so the icon fills in on its own.
  if (attempts < ICON_MAX_ATTEMPTS) {
    setTimeout(() => queueIcon(name, isMounted), delay);
  }
}

/**
 * Whether `name` should be queued right now.
 *
 * A success is cached forever and never refetched. A failure is subject to a
 * cooldown and an attempt cap, so a render storm cannot become a fetch storm
 * while a genuinely broken subreddit is not hammered forever. The cap is
 * released after ICON_FAILURE_RESET, so a subreddit blocked in one window is
 * tried again later instead of staying grey for good.
 */
function shouldQueue(name) {
  if (iconCache[name]) return false;
  if (iconInFlight.has(name)) return false;
  if (iconQueue.includes(name)) return false;
  const f = iconFailures[name];
  if (!f) return true;
  if (f.attempts >= ICON_MAX_ATTEMPTS) {
    if (Date.now() - f.firstFailedAt < ICON_FAILURE_RESET) return false;
    // The cap has expired: start the backoff over.
    delete iconFailures[name];
    return true;
  }
  return Date.now() >= f.nextTryAt;
}

/** Send one request for `name`; the result is patched in by its callbacks. */
function requestIcon(name, isMounted) {
  iconInFlight.add(name);

  GM_xmlhttpRequest({
    method: 'GET',
    url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
    headers: { Accept: 'application/json' },
    onload(res) {
      iconInFlight.delete(name);

      // The status is load-bearing. Under rate limiting reddit returns a 403
      // whose body is an HTML error page; parsing that is what used to swallow
      // the failure and freeze the placeholder as if the subreddit had no icon.
      let icon = '';
      if (res.status === 200) {
        try {
          const data = JSON.parse(res.responseText);
          icon = data.data?.icon_img || data.data?.community_icon || '';
        } catch { /* not JSON after all: a failure, not "this sub has no icon" */ }
        // Reddit sometimes returns an HTML-escaped URL.
        icon = icon.replace(/&amp;/g, '&');
      }

      if (icon) {
        recordIcon(name, icon, isMounted);
        return;
      }
      recordFailure(name, isMounted);
    },
    onerror() {
      iconInFlight.delete(name);
      recordFailure(name, isMounted);
    },
  });
}

/**
 * Send queued requests one at a time, spaced by ICON_REQUEST_GAP.
 *
 * Serializing is deliberate: reddit rate-limits about.json, and a burst of one
 * request per row is the most likely trigger. The pump stops when the queue
 * drains and is restarted by the next queueIcon().
 */
function pumpIconQueue(isMounted) {
  if (iconPumpRunning) return;
  const next = iconQueue.shift();
  if (!next) return;

  iconPumpRunning = true;
  requestIcon(next, isMounted);
  setTimeout(() => {
    iconPumpRunning = false;
    pumpIconQueue(isMounted);
  }, ICON_REQUEST_GAP);
}

/** Queue a fetch for `name` unless it is cached, in flight, or capped out. */
function queueIcon(name, isMounted) {
  if (!shouldQueue(name)) return;
  iconQueue.push(name);
  pumpIconQueue(isMounted);
}

/**
 * Resolve `name`'s icon. Returns the currently-known icon immediately (the
 * placeholder until one arrives) and schedules a fallback fetch if needed.
 *
 * Safe to call on every render: an already-resolved name returns its URL without
 * any request, and a name already queued or in flight is not fetched twice.
 */
export function fetchSubredditIcon(name, isMounted) {
  queueIcon(name, isMounted);
  return cachedIcon(name);
}
