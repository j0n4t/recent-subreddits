// Subreddit icons
//
// Fetching an icon is unreliable on the live site: reddit answers
// /r/<name>/about.json with a 403 and an HTML "blocked by network security"
// page — per-subreddit and time-varying (measured: two of twelve subreddits 403
// on every attempt while their neighbours succeed, and the same subreddit 403s
// in one run and returns 200 in the next). So:
//
//   * a failure is NOT cached as settled. Only a successful icon is cached
//     forever; a failure is remembered only long enough to back off, so a later
//     render can try again. Caching a transient 403 permanently is what left
//     grey circles in the list for the life of the page.
//   * requests are SERIALIZED and spaced, because firing one per row at once is
//     the most likely trigger for that rate limiting.
export const DEFAULT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";

// How many times one subreddit's icon is attempted before it is left alone.
export const ICON_MAX_ATTEMPTS = 4;
// Delay before each retry (index 0 = the first retry). Short enough to recover
// within a single popup open, long enough to let a rate limiter relax.
export const ICON_RETRY_DELAYS = [800, 2000, 4000];
// Spacing between the starts of consecutive requests across subreddits.
export const ICON_REQUEST_GAP = 120;
// Once the attempt cap is hit, wait this long before trying that subreddit
// again. Measured: the set of subreddits reddit 403s changes from run to run
// and holds for a whole session, so a row that is blocked now may well answer
// minutes later. Without this reset, one bad window greys a row forever.
export const ICON_FAILURE_RESET = 5 * 60_000;

// name -> icon URL. Only ever holds a SUCCESS: a failed lookup must not be
// readable here, or a caller would treat the grey placeholder as final.
const iconCache = {};
// name -> { attempts, nextTryAt, firstFailedAt }. Bookkeeping for a subreddit
// whose fetch has not succeeded yet; dropped as soon as one does.
const iconFailures = {};
// Names queued or currently in flight, so one name is never requested twice.
const iconQueue = [];
const iconInFlight = new Set();
let iconPumpRunning = false;

/** Escape a value for interpolation into an HTML attribute. */
export function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

/** The icon cached for `name`, or the placeholder. Never triggers a fetch. */
export function cachedIcon(name) {
  return iconCache[name] || DEFAULT_ICON;
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
        // Settled: cached forever, and any failure record is dropped.
        iconCache[name] = icon;
        delete iconFailures[name];
        updateIconInDom(name, icon, isMounted);
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
 * Fetch `name`'s icon. Returns the currently-known icon immediately (the
 * placeholder until one arrives) and schedules the request. Safe to call on
 * every render: a cached success is returned without a request, and a name
 * already queued or in flight is not requested twice.
 */
export function fetchSubredditIcon(name, isMounted) {
  queueIcon(name, isMounted);
  return cachedIcon(name);
}
