// Subreddit icons
//
// One fetch per subreddit, cached forever (including failures, which fall back
// to a placeholder) — the list re-renders often and must never re-request.
export const DEFAULT_ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";

const iconCache = {};

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

export function fetchSubredditIcon(name, isMounted) {
  // `name in iconCache` also covers the placeholder set below, so we never
  // fire the same request twice (including after a failed fetch).
  if (name in iconCache) return iconCache[name];

  iconCache[name] = DEFAULT_ICON; // placeholder while loading

  GM_xmlhttpRequest({
    method: 'GET',
    url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
    headers: { Accept: 'application/json' },
    onload(res) {
      let icon = '';
      try {
        const data = JSON.parse(res.responseText);
        icon = data.data?.icon_img || data.data?.community_icon || '';
      } catch { /* ignore */ }
      // Reddit sometimes returns an HTML-escaped URL
      icon = icon.replace(/&amp;/g, '&');
      iconCache[name] = icon || DEFAULT_ICON;
      updateIconInDom(name, iconCache[name], isMounted);
    },
    onerror() {
      iconCache[name] = DEFAULT_ICON;
    },
  });

  return DEFAULT_ICON;
}
