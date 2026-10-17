// README screenshot: the popup, on a real reddit page, opened by hovering the
// logo the way a user does.
//
// Why this is not part of `npm run check`:
//
//   * It needs a real reddit page, so it cannot run offline against the fixture
//     (the fixture's body is mock markup and its icon CDN does not resolve, so a
//     screenshot of it would document something the user never sees).
//   * Reddit's bot protection blocks a HEADLESS browser outright — measured, not
//     assumed: headless returns "You've been blocked by network security" with
//     no feed, while a headful window with the manual suite's cleared profile
//     renders the real page. So it is headful-only.
//   * A PNG is not reproducible across machines (fonts, DPI, antialiasing), so
//     unlike the userscript artifact it cannot be freshness-gated in CI.
//
// It is therefore a local, on-demand tool. Run:  npm run screenshot
//
// Requires the persistent profile the manual suite uses (.manual-profile), where
// reddit's JS challenge has been cleared once. If reddit re-challenges, this
// fails loudly rather than writing a screenshot of a block page.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { Browser, findBrowser } from '../tests/e2e/cdp-harness.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(ROOT, 'recent-subreddits.user.js'), 'utf8');
const PROFILE = process.env.RS_MANUAL_PROFILE || join(ROOT, '.manual-profile');
const OUT_DIR = join(ROOT, 'docs');
const PAGE = process.env.RS_SCREENSHOT_URL || 'https://www.reddit.com/r/javascript/';

// A desktop viewport, so the header (and therefore the trigger) is laid out the
// way a desktop user sees it — reddit hides the logo below ~1000px.
const VIEWPORT = { width: 1440, height: 900 };
// 2x, so the text in the README is crisp rather than upscaled.
const SCALE = 2;
// Room around the popup for its own shadow, so the crop does not clip it.
const PAD = 18;

// Seeded so the popup has something to show. Real subreddits, because their
// icons are harvested from their real pages (see harvestIcons()).
// A pinned name must ALSO be in recent: that is where its visit time lives.
const SEED = {
  recent: [
    { name: 'javascript', visitedAt: Date.now() - 40_000 },
    { name: 'linux', visitedAt: Date.now() - 11 * 60_000 },
    { name: 'webdev', visitedAt: Date.now() - 3 * 3_600_000 },
    { name: 'rust', visitedAt: Date.now() - 26 * 3_600_000 },
    // NOT 'python': probed, /r/python/ never renders the subreddit header or the
    // icon anchor here (no feed either, at any delay), so its row would show the
    // grey placeholder. typescript renders reliably.
    { name: 'typescript', visitedAt: Date.now() - 2 * 86_400_000 },
    { name: 'golang', visitedAt: Date.now() - 3 * 86_400_000 },
    { name: 'selfhosted', visitedAt: Date.now() - 4 * 86_400_000 },
    { name: 'docker', visitedAt: Date.now() - 5 * 86_400_000 },
    { name: 'commandline', visitedAt: Date.now() - 6 * 86_400_000 },
    { name: 'vim', visitedAt: Date.now() - 7 * 86_400_000 },
  ],
  pinned: ['linux', 'rust'],
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a page expression until truthy, or give up. */
async function waitFor(b, expr, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await b.evaluate(expr);
    if (last) return last;
    await delay(150);
  }
  throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

/**
 * Harvest each seeded subreddit's real icon by visiting its page.
 *
 * This is the same mechanism the userscript uses in production, and it is the
 * ONLY one that works here — measured, on this connection:
 *
 *   * `/r/<name>/about.json` answers 403 for every subreddit, under every fetch
 *     variant tried (plain, credentials:'include', no Accept header). That is
 *     the rate-limiting src/icons.js documents, and why the fetch is only a
 *     fallback there.
 *   * The harvest reads 5/5. Reddit renders the current subreddit's own icon
 *     into `#subreddit-icon-img`, already in cache, costing no request.
 *
 * So the screenshot walks the subreddit pages, which is what a real user does
 * anyway — and it is why the rows show real icons rather than grey circles.
 * Returns a name -> icon URL map, ready to seed the icon cache with.
 */
async function harvestIcons(b, names) {
  const icons = {};
  const failed = [];
  for (const name of names) {
    await b.goto(`https://www.reddit.com/r/${name}/`);
    try {
      const icon = await waitFor(
        b,
        `(() => {
           const el = document.getElementById('subreddit-icon-img');
           const img = el ? (el.tagName === 'IMG' ? el : el.querySelector('img')) : null;
           return img ? img.getAttribute('src') : null;
         })()`,
        `the icon anchor on /r/${name}/`,
        8000
      );
      icons[name] = icon;
    } catch {
      failed.push(name);
    }
  }
  return { icons, failed };
}

/**
 * Seed the store, THEN inject the userscript, then hover the logo to open the
 * popup — the way a user actually opens it.
 *
 * Three things here are load-bearing and were all established by measurement:
 *
 *   * THE THEME IS EMULATED BEFORE NAVIGATION. Reddit reads the system
 *     preference when it builds the document: with `prefers-color-scheme: dark`
 *     it loads `theme-dark` natively, and with `light` it loads `theme-beta`
 *     with a white page. Emulating first therefore gives a natively light or
 *     dark PAGE, not one forced by adding a class after the fact. (The popup
 *     styles itself from the same media query, so one lever drives both and they
 *     cannot disagree.)
 *
 *   * THE ORDER OF INJECTION. The script reads the store once at load.
 *     Injecting first and re-injecting after seeding mounts a SECOND container,
 *     and `querySelector('#rs-popup')` then returns the stale one — measured as
 *     a 123px popup with one row instead of the real 215px with three.
 */
async function shoot(b, theme, icons) {
  // Set before navigating: reddit picks its theme at document build time.
  await b.session('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: theme }],
  });

  await b.goto(PAGE);

  const state = await b.evaluate(`({
    blocked: document.body.innerText.includes('blocked by network security'),
    hasFeed: !!document.querySelector('shreddit-post, shreddit-feed, #main-content'),
  })`);
  if (state.blocked || !state.hasFeed) {
    throw new Error(
      `reddit did not render a real page (blocked=${state.blocked}, feed=${state.hasFeed}).\n` +
      `  Open .manual-profile once in a visible window and solve the challenge, then re-run.`
    );
  }

  // Verify the page really took the theme, so a mismatch cannot ship silently.
  const dark = await b.evaluate(
    `getComputedStyle(document.documentElement).colorScheme === 'dark'`
  );
  if (dark !== (theme === 'dark')) {
    console.log(`  ! page colorScheme is ${dark ? 'dark' : 'light'} but ${theme} was requested`);
  }

  // The GM_* surface, then the seeded store, then the script — in that order.
  await b.evaluate(`(() => {
    window.__warns = [];
    window.__errors = [];
    window.__store = {
      recentSubreddits: ${JSON.stringify(JSON.stringify(SEED))},
      recentSubredditsIcons: ${JSON.stringify(JSON.stringify(icons))},
    };
    window.GM_getValue = (k, d) => (k in window.__store ? window.__store[k] : d);
    window.GM_setValue = (k, v) => { window.__store[k] = v; };
    window.GM_xmlhttpRequest = (o) => {
      fetch(o.url, { headers: o.headers || {} })
        .then((r) => r.text())
        .then((t) => o.onload && o.onload({ responseText: t, status: 200 }))
        .catch(() => o.onerror && o.onerror());
    };
    window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  })()`);
  await b.evaluate(`${SCRIPT}\n;("injected")`);

  // Hover the logo with a REAL pointer move, not a synthetic mouseover: the
  // popup is what a user sees from actually hovering, and a synthetic event
  // bypasses hit-testing. #reddit-logo is the trigger with a real box here
  // (measured 76x22 at 17,17 — reddit hides it below ~1000px, so the viewport
  // must stay desktop-width).
  const logo = await b.evaluate(`(() => {
    for (const sel of ['#reddit-logo', '[data-testid="top-nav-logo"]', 'a[href="/"]']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { sel, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 left: Math.round(r.left), top: Math.round(r.top),
                 width: Math.round(r.width), height: Math.round(r.height) };
      }
    }
    return null;
  })()`);
  if (!logo) {
    throw new Error('no logo trigger with a visible box — is the viewport desktop-width?');
  }
  // Move away first, so the pointer genuinely ENTERS the target.
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 400, button: 'none' }, b.sessionId);
  await delay(200);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: logo.x, y: logo.y, button: 'none' }, b.sessionId);
  await waitFor(b, `!!document.querySelector('#rs-popup')?.classList.contains('visible')`,
    `the popup to open from hovering ${logo.sel}`);

  // Hover the popup header so the logo's native tooltip is dismissed.
  const header = await b.evaluate(`(() => {
    const el = document.querySelector('#rs-popup .rs-header-row');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (header) {
    await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: header.x, y: header.y, button: 'none' }, b.sessionId);
    await delay(300);
  }

  // One popup, or the capture would frame the wrong element.
  const count = await b.evaluate(`document.querySelectorAll('#rs-popup').length`);
  if (count !== 1) {
    throw new Error(`expected 1 popup, found ${count} — the script was injected twice`);
  }

  // Icons are network images; wait for them to decode or the shot has holes.
  await waitFor(
    b,
    `Array.from(document.querySelectorAll('#rs-popup img.rs-icon'))
       .every((i) => i.complete && i.naturalWidth > 0)`,
    'the row icons to load',
    10000
  ).catch(() => console.log('  (some icons did not load in time — capturing anyway)'));

  await delay(400); // let the fade-in finish

  // Scroll to the top first: the popup is position:fixed, and a clip is
  // resolved against the document, so a scrolled page would offset the crop.
  await b.evaluate('window.scrollTo(0, 0)');
  const rect = await b.evaluate(`(() => {
    const r = document.querySelector('#rs-popup').getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top),
             width: Math.round(r.width), height: Math.round(r.height) };
  })()`);

  // Frame the popup with the logo it is anchored to above it — so the shot
  // shows where the list comes from — but keep the crop tight to those two.
  //
  // A wider crop (measured) pulls in reddit's logged-out login rail: white
  // "Continuar com email" buttons at x=32, y=302+, which hardcode bg-white and
  // ignore theme-dark. That is reddit's own element, not the popup, but it makes
  // a dark shot look broken, so the crop is kept to the popup's own column.
  const left = Math.min(rect.x, logo.left);
  const top = Math.min(rect.y, logo.top);
  const right = Math.max(rect.x + rect.width, logo.left + logo.width);
  const bottom = rect.y + rect.height;

  // Clamp to the viewport: a clip that runs past the edge captures blank.
  const x = Math.max(0, left - PAD);
  const y = Math.max(0, top - PAD);
  const clip = {
    x,
    y,
    width: Math.min(VIEWPORT.width - x, right - left + PAD * 2),
    height: Math.min(VIEWPORT.height - y, bottom - top + PAD * 2),
  };

  const png = await b.captureScreenshot({ clip });
  const file = join(OUT_DIR, `popup-${theme}.png`);
  writeFileSync(file, png);
  const rows = await b.evaluate(`document.querySelectorAll('#rs-popup .rs-item').length`);
  console.log(`  ${theme}: popup ${rect.width}x${rect.height} under ${logo.sel}` +
    `, ${rows} rows -> ${file}`);
  return file;
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error('no Chromium found (set E2E_BROWSER to override)');
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });

console.log(`browser: ${browserPath}`);
console.log(`profile: ${PROFILE}`);
console.log(`page:    ${PAGE}`);
console.log(`viewport: ${VIEWPORT.width}x${VIEWPORT.height} @${SCALE}x\n`);

// Headful is required, not a preference: reddit blocks the headless UA outright.
const b = await Browser.launch({ headful: true, userDataDir: PROFILE });
if (!b) {
  console.error('browser failed to launch');
  process.exit(1);
}

try {
  await b.session('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width,
    height: VIEWPORT.height,
    deviceScaleFactor: SCALE,
    mobile: false,
  });

  const names = [...new Set([...SEED.pinned, ...SEED.recent.map((r) => r.name)])];
  console.log(`harvesting ${names.length} icons (one page visit each)...`);
  const { icons, failed } = await harvestIcons(b, names);
  console.log(`  ${Object.keys(icons).length}/${names.length} harvested` +
    (failed.length ? ` (no icon anchor on: ${failed.join(', ')})` : ''));
  if (failed.length) console.log('  (rows without an icon render the grey placeholder)');

  for (const theme of ['light', 'dark']) {
    await shoot(b, theme, icons);
  }
  console.log('\ndone.');
} catch (err) {
  console.error(`\n!! ${err.message}`);
  process.exitCode = 1;
} finally {
  await b.stop();
}
