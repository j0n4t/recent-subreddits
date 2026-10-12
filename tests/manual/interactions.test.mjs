// Manual, human-in-the-loop tests against REAL reddit.com.
//
// This is the suite that catches what the automated one cannot: whether the
// feature is usable by a person on the real site. It drives a HEADFUL browser
// and stops at each step for you to confirm what you see.
//
//   npm run test:real
//
// Why it exists: the headless suite runs against tests/fixtures/reddit-mock.html,
// so it can only assert things about markup we wrote ourselves. Real Reddit
// differs in ways that matter (the logo collapses to 0x0 below desktop width,
// the header lives in a shadow root, ancestors are static) and has already
// produced one bug the fixture could not see.
//
// Two modes:
//   * Live mode (default): injects the userscript into www.reddit.com. Needs a
//     session that has cleared Reddit's JS challenge — the first run may show a
//     "blocked by network security" page; solve it once in the window and the
//     persistent profile keeps it solved.
//   * Offline mode (--offline): drives the local fixture instead, for checking
//     the interactions themselves without touching reddit.com.
//
// Answers are read from stdin, so this is not part of `npm run check`.

import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { Browser, findBrowser } from '../e2e/cdp-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const FIXTURE = pathToFileURL(join(HERE, '..', 'fixtures', 'reddit-mock.html')).href;
const SCRIPT = readFileSync(join(ROOT, 'recent-subreddits.user.js'), 'utf8');

// A profile that outlives the run, so Reddit's challenge is cleared once.
const PROFILE = process.env.RS_MANUAL_PROFILE || join(ROOT, '.manual-profile');
const OFFLINE = process.argv.includes('--offline');

const rl = createInterface({ input: process.stdin, output: process.stdout });
let stdinClosed = false;
rl.on('close', () => { stdinClosed = true; });

/** Ask the human a question. Answers come from stdin; EOF is treated as skip. */
const ask = (q) =>
  new Promise((resolve) => {
    if (stdinClosed) {
      console.log(`${q}(stdin closed — skipping)`);
      return resolve('');
    }
    try {
      rl.question(q, (a) => resolve(String(a).trim()));
    } catch {
      resolve('');
    }
  });

const results = [];

/**
 * Ask the human to confirm one observable thing.
 *
 * `autoPass` records a verdict the script already knows from measurement (e.g.
 * geometry), so a machine-checkable assertion is not lost when the human skips
 * or stdin is not interactive.
 */
async function check(label, question, autoPass = false) {
  const answer = (await ask(`\n  ${question}\n  [y] yes  [n] no  [s] skip  > `)).toLowerCase();
  const verdict =
    answer === 'y' ? 'pass' : answer === 'n' ? 'FAIL' : autoPass ? 'pass (auto)' : 'skipped';
  results.push({ label, verdict });
  console.log(`  -> ${verdict}`);
}

function header(text) {
  console.log(`\n${'='.repeat(64)}\n${text}\n${'='.repeat(64)}`);
}

// ---------------------------------------------------------------------------

const browserPath = findBrowser();
if (!browserPath) {
  console.error('No Chromium found. Set E2E_BROWSER to a browser binary.');
  process.exit(1);
}

header(
  `Manual test — ${OFFLINE ? 'OFFLINE (local fixture)' : 'LIVE (www.reddit.com)'}\n` +
  `browser: ${browserPath}\n` +
  `profile: ${OFFLINE ? '(throwaway)' : PROFILE}`
);

const b = await Browser.launch({
  headful: true,
  userDataDir: OFFLINE ? null : PROFILE,
});
if (!b) {
  console.error('browser failed to launch');
  process.exit(1);
}
// Handy while a run is paused on a question: attach any CDP tool to this port.
console.log(`CDP port: ${b.cdpPort}  (http://127.0.0.1:${b.cdpPort}/json/list)`);

// Ctrl-C must not leak a window or a profile.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\ninterrupted — cleaning up the browser.');
    b.stop().finally(() => process.exit(130));
  });
}

try {
  if (OFFLINE) {
    await runOffline();
  } else {
    await runLive();
  }
} catch (err) {
  console.error(`\n  !! the run threw: ${err.message}`);
  results.push({ label: `run completed (${err.message.slice(0, 60)})`, verdict: 'FAIL' });
} finally {
  // Leave the window open: the point is for the human to look at it.
  header('SUMMARY');
  for (const r of results) {
    const mark = r.verdict.startsWith('pass')
      ? 'PASS'
      : r.verdict === 'FAIL'
        ? 'FAIL'
        : 'skip';
    console.log(`  ${mark.padEnd(5)} ${r.label}${r.verdict === 'pass (auto)' ? '  [measured]' : ''}`);
  }
  const failed = results.filter((r) => r.verdict === 'FAIL');
  console.log(
    failed.length
      ? `\n  ${failed.length} interaction(s) FAILED — that is a real bug, not a test problem.`
      : `\n  No failures reported.`
  );

  const close = (await ask('\nClose the browser? [y/N] > ')).toLowerCase();
  if (close === 'y') {
    await b.stop();
    console.log('browser closed.');
  } else {
    // Never leave a window running unattended: with no interactive stdin there
    // is nobody to close it, so it would leak until the next cleanup.
    await b.stop();
    console.log(
      stdinClosed
        ? 'stdin closed — closed the browser to avoid leaking a window.'
        : `browser left open (profile kept at ${PROFILE}).`
    );
  }
  rl.close();
}

// ---------------------------------------------------------------------------
// LIVE: the real site.
// ---------------------------------------------------------------------------

async function runLive() {
  header('STEP 0 — get to a real reddit page');
  console.log(`
  The browser is opening www.reddit.com/r/javascript/.
  If you see "You've been blocked by network security", solve the challenge
  (or reload) until the real feed appears. The persistent profile means you
  should only have to do this once.
`);
  await b.goto('https://www.reddit.com/r/javascript/');
  await ask('  Press Enter once you can see the real subreddit feed. ');

  const state = await b.evaluate(`({
    url: location.href.split('?')[0],
    title: document.title.slice(0, 40),
    hasFeed: !!document.querySelector('shreddit-post, shreddit-feed, #main-content'),
    blocked: document.body.innerText.includes('blocked by network security'),
  })`);
  console.log(`  page: ${JSON.stringify(state)}`);
  if (state.blocked || !state.hasFeed) {
    console.log('\n  Still blocked / no feed detected. Re-run once you have a working session.');
    results.push({ label: 'reached a real reddit page', verdict: 'FAIL' });
    return;
  }
  results.push({ label: 'reached a real reddit page', verdict: 'pass' });

  // ---- inject ----
  header('STEP 1 — inject the userscript');
  await injectIntoPage();
  const mounted = await b.evaluate(`({
    containers: document.querySelectorAll('.recent-subreddits-container').length,
    popup: !!document.querySelector('#rs-popup'),
    styles: !!document.getElementById('rs-styles'),
    errors: window.__errors,
  })`);
  console.log(`  ${JSON.stringify(mounted)}`);
  await check('userscript mounts on real reddit', 'Did the script load without console errors?');

  // ---- hotkey ----
  header('STEP 2 — hotkey opens the popup');
  console.log('\n  I am pressing Alt+Shift+R for you now.');
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', altKey: true, shiftKey: true, bubbles: true, cancelable: true }))`);
  await delayMs(600);
  const vis = await b.evaluate(`(() => {
    const p = document.querySelector('#rs-popup');
    const r = p.getBoundingClientRect();
    return { visible: p.classList.contains('visible'), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log(`  popup: ${JSON.stringify(vis)}`);
  await check(
    'hotkey opens the popup',
    `Is the popup visible, centred, and showing a recent list (${vis.w}x${vis.h})?`
  );

  // ---- hover the logo ----
  header('STEP 3 — hovering the reddit logo');
  const logo = await b.evaluate(`(() => {
    const el = document.querySelector('#reddit-logo');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  console.log(`\n  #reddit-logo box: ${JSON.stringify(logo)}`);
  if (!logo || logo.w === 0) {
    console.log(`
  The logo has no box at this window width — Reddit hides it below ~1000px
  and the menu button is the trigger there. Widen the window, then tell me
  the width it reports.
`);
    await ask('  Press Enter after widening the window. ');
    console.log(`  innerWidth is now ${await b.evaluate('innerWidth')}`);
  }
  console.log('\n  I am dispatching a real mouse hover over the logo.');
  await hoverReal('#reddit-logo');
  await delayMs(800);
  const hovered = await b.evaluate(`document.querySelector('#rs-popup').classList.contains('visible')`);
  console.log(`  popup visible after hover: ${hovered}`);
  await check('hovering the logo opens the popup', 'Did the popup open when I hovered the logo?');

  // ---- interact with the popup as a user ----
  header('STEP 4 — use the popup');
  await check(
    'list is readable',
    'Can you read the recent list — icons, names, and relative times?'
  );
  await check(
    'styling suits the page',
    'Does the popup look right against the page (readable text, sensible contrast)?'
  );

  console.log('\n  I am clicking a subreddit link in the popup...');
  await b.evaluate(`(() => {
    const a = document.querySelector('#rs-popup .rs-link');
    if (a) a.click();
    return a ? a.textContent : null;
  })()`);
  await delayMs(2500);
  const afterNav = await b.evaluate(`({
    path: location.pathname,
    recent: JSON.parse(window.__store.recentSubreddits || '{"recent":[]}').recent.map(r => r.name),
    rendered: Array.from(document.querySelectorAll('#rs-popup .rs-link')).map(a => a.textContent),
  })`);
  console.log(`  ${JSON.stringify(afterNav)}`);
  await check(
    'clicking a subreddit navigates and records the visit',
    'Did the page navigate, and does the new subreddit now appear in the list?'
  );

  // ---- inline modes on real markup ----
  header('STEP 5 — inline replace on a real element (the bug we just fixed)');
  console.log(`
  I will now bind "replace" to a real container (#main-content) and screenshot
  the geometry. The block must render OVER that element, not at the page origin.
`);
  await ask('  Press Enter to apply the replace target. ');
  const replaceGeo = await b.evaluate(`
    (async () => {
      const el = document.querySelector('#main-content');
      if (!el) return { error: 'no #main-content' };
      const before = { position: getComputedStyle(el).position };
      // Drive the real code path: write the setting, then re-run applyTargets
      // via a fresh injection so we exercise mount, not a hand-built node.
      window.__store.recentSubredditsSettings = JSON.stringify({
        hotkey: 'Alt+Shift+R',
        targets: [{ selector: '#main-content', mode: 'replace' }],
      });
      document.querySelector('.recent-subreddits-container')?.remove();
      document.querySelectorAll('.rs-inline-host').forEach(n => n.remove());
      return { before, seeded: true };
    })()
  `);
  console.log(`  seeded: ${JSON.stringify(replaceGeo)}`);
  await injectIntoPage();
  await delayMs(1200);
  const geo = await b.evaluate(`(() => {
    const el = document.querySelector('#main-content');
    const inst = document.querySelector('.rs-inline');
    if (!el || !inst) return { el: !!el, inst: !!inst };
    const eb = el.getBoundingClientRect(), ib = inst.getBoundingClientRect();
    // Probe INSIDE THE BLOCK, on screen. The replaced element can be far taller
    // than the block (a whole feed container), so its own centre may sit below
    // the block entirely and report a false negative.
    const y = Math.round(Math.max(ib.top, 0) + Math.min(ib.height, innerHeight - Math.max(ib.top, 0)) / 2);
    const x = Math.round(ib.left + ib.width / 2);
    const hit = document.elementFromPoint(x, y);
    // If the block is not on top, find out WHAT is — a block that renders in the
    // right place but sits behind other content is just as invisible to the user.
    let coveredBy = null;
    if (hit && !(inst === hit || inst.contains(hit))) {
      const chain = [];
      let n = hit;
      for (let i = 0; i < 4 && n; i++) {
        chain.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : '')
          + ' (z=' + getComputedStyle(n).zIndex + ', ' + getComputedStyle(n).position + ')');
        n = n.parentElement;
      }
      coveredBy = chain;
    }
    return {
      element: { t: Math.round(eb.top), l: Math.round(eb.left), h: Math.round(eb.height) },
      block: { t: Math.round(ib.top), l: Math.round(ib.left) },
      probePoint: { x, y },
      dx: Math.round(ib.left - eb.left), dy: Math.round(ib.top - eb.top),
      elementPosition: getComputedStyle(el).position,
      hitIsBlock: !!hit && (inst === hit || inst.contains(hit)),
      hitTag: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null,
      coveredBy,
      blockZ: getComputedStyle(inst).zIndex,
      hostZ: getComputedStyle(inst.parentElement).zIndex,
    };
  })()`);
  console.log(`  ${JSON.stringify(geo, null, 2)}`);
  const overlaps = Math.abs(geo.dx) <= 2 && Math.abs(geo.dy) <= 2;
  const autoPass = overlaps && geo.hitIsBlock;
  await check(
    'replace renders over the element it replaced',
    `The block should sit over the element (dx=${geo.dx}, dy=${geo.dy}, on top=${geo.hitIsBlock}). Does it look right on screen?`,
    // The geometry is machine-checkable, so record it even if the human skips.
    autoPass
  );

  header('STEP 6 — tear it down');
  await b.evaluate(`document.querySelector('.rs-inline .rs-close-btn')?.click()`);
  await delayMs(800);
  const torn = await b.evaluate(`(() => {
    const el = document.querySelector('#main-content');
    return {
      blockGone: !document.querySelector('.rs-inline-host'),
      position: el ? getComputedStyle(el).position : null,
      visibility: el ? getComputedStyle(el).visibility : null,
    };
  })()`);
  console.log(`  ${JSON.stringify(torn)}`);
  await check(
    'teardown restores the page',
    'Is the page back to normal — content visible, nothing left behind?'
  );

  // ---- the logged-out login rail ----
  header('STEP 7 — replace the useless login left sidebar');
  console.log(`
  Binding "replace" to #left-sidebar-container — the logged-out rail that only
  advertises signing in. Two things must be true: the rail's login prompt must
  be GONE, and the subreddit list must be visible in its place. Reddit ships a
  descendant with an explicit visibility:visible there, which is why hiding the
  element alone used to leave the prompt painted over the block.
`);
  await ask('  Press Enter to bind replace to the login rail. ');

  const railBefore = await b.evaluate(`(() => {
    const el = document.querySelector('#left-sidebar-container');
    if (!el) return { found: false };
    const r = el.getBoundingClientRect();
    return {
      found: true,
      rect: { t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) },
      hasLoginPrompt: (el.innerText || '').includes('Continuar com'),
    };
  })()`);
  console.log(`  rail before: ${JSON.stringify(railBefore)}`);

  await b.evaluate(`
    (() => {
      window.__store.recentSubredditsSettings = JSON.stringify({
        hotkey: 'Alt+Shift+R',
        targets: [{ selector: '#left-sidebar-container', mode: 'replace' }],
      });
      document.querySelector('.recent-subreddits-container')?.remove();
      document.querySelectorAll('.rs-inline-host').forEach((n) => n.remove());
      return 'seeded';
    })()
  `);
  await injectIntoPage();
  await delayMs(1500);

  const railAfter = await b.evaluate(`(() => {
    const rail = document.querySelector('#left-sidebar-container');
    const inst = document.querySelector('.rs-inline');
    if (!inst || !rail) return { mounted: false, rail: !!rail, block: !!inst };
    const ib = inst.getBoundingClientRect();
    const rb = rail.getBoundingClientRect();
    // Is any login prompt still PAINTED? Check every descendant's computed
    // visibility, not just the element's — that is the bug being guarded.
    let promptPainted = 0;
    for (const el of rail.querySelectorAll('*')) {
      if (inst.contains(el)) continue;
      if (getComputedStyle(el).visibility !== 'visible') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.height < 10) continue;
      if ((el.innerText || '').includes('Continuar com')) promptPainted++;
    }
    const y = Math.round(Math.max(ib.top, 0) + Math.min(ib.height, innerHeight - Math.max(ib.top, 0)) / 2);
    const hit = document.elementFromPoint(Math.round(ib.left + ib.width / 2), y);
    return {
      mounted: true,
      railMarked: rail.classList.contains('rs-replacing'),
      block: { t: Math.round(ib.top), l: Math.round(ib.left), w: Math.round(ib.width) },
      rail: { t: Math.round(rb.top), l: Math.round(rb.left), w: Math.round(rb.width) },
      dx: Math.round(ib.left - rb.left),
      dy: Math.round(ib.top - rb.top),
      promptElementsStillPainted: promptPainted,
      blockOnTop: !!hit && (inst === hit || inst.contains(hit)),
      blockItems: inst.querySelectorAll('.rs-item').length,
      errors: window.__errors,
    };
  })()`);
  console.log(`  ${JSON.stringify(railAfter, null, 2)}`);

  await check(
    'login rail replaced, prompt gone',
    `The sidebar should show the subreddit list with NO login buttons ` +
    `(prompt elements still painted: ${railAfter.promptElementsStillPainted}, ` +
    `dx=${railAfter.dx}, dy=${railAfter.dy}, on top=${railAfter.blockOnTop}). ` +
    `Look at the left sidebar: is the login prompt gone and the list readable?`,
    // Machine-checkable: block over the rail, on top, and no prompt painted.
    railAfter.mounted === true &&
      railAfter.dx === 0 &&
      railAfter.dy === 0 &&
      railAfter.blockOnTop === true &&
      railAfter.promptElementsStillPainted === 0
  );
}

// ---------------------------------------------------------------------------
// OFFLINE: the local fixture, for checking interactions without reddit.com.
// ---------------------------------------------------------------------------

async function runOffline() {
  header('STEP 1 — local fixture');
  const seed = Buffer.from(
    JSON.stringify({
      recent: [
        { name: 'javascript', visitedAt: Date.now() - 60_000 },
        { name: 'linux', visitedAt: Date.now() - 600_000 },
        { name: 'webdev', visitedAt: Date.now() - 7_200_000 },
      ],
      pinned: ['rust'],
    }),
    'utf8'
  ).toString('base64');
  await b.goto(`${FIXTURE}?seed=${encodeURIComponent(seed)}`);
  await b.waitUntil(`!!document.querySelector('#rs-popup')`, 'popup to mount');
  await ask('  The fixture page is loaded. Press Enter to continue. ');

  header('STEP 2 — hover the logo');
  await hoverReal('#logo');
  await delayMs(700);
  const vis = await b.evaluate(`document.querySelector('#rs-popup').classList.contains('visible')`);
  console.log(`  popup visible after hover: ${vis}`);
  await check('hover opens the popup', 'Did the popup open?');

  header('STEP 3 — pin and unpin');
  console.log('\n  I am clicking the pin button on r/javascript.');
  await b.evaluate(`document.querySelector('.rs-pin-btn[data-name="javascript"]')?.click()`);
  await delayMs(500);
  const pinned = await b.evaluate(`Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent)`);
  console.log(`  pinned now: ${JSON.stringify(pinned)}`);
  await check('pinning works', 'Did r/javascript move to the Pinned section, popup still open?');

  header('STEP 4 — settings and hotkey capture');
  await b.evaluate(`document.querySelector('.rs-settings-btn')?.click()`);
  await delayMs(500);
  await b.evaluate(`document.querySelector('.rs-hotkey-input')?.focus()`);
  await check('settings panel opens', 'Can you see the settings panel with the hotkey field?');

  header('STEP 5 — element picker');
  await b.evaluate(`document.querySelector('[data-role="pick"]')?.click()`);
  await delayMs(400);
  const picker = await b.evaluate(`({
    hint: !!document.getElementById('rs-picker-hint'),
    box: !!document.getElementById('rs-picker-box'),
    popupClosed: !document.querySelector('#rs-popup').classList.contains('visible'),
  })`);
  console.log(`  ${JSON.stringify(picker)}`);
  await check(
    'picker activates',
    'Did the popup close and a hint bar appear at the bottom? Hover an element to see the outline.'
  );
  await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await delayMs(400);
  await check('picker cancels on Escape', 'Did the picker go away and the settings panel come back?');
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Inject the built userscript with GM_* stubs, once per page. */
async function injectIntoPage() {
  await b.evaluate(`
(() => {
  window.__warns = window.__warns || [];
  window.__errors = window.__errors || [];
  window.__store = window.__store || {};
  window.GM_getValue = (k, d) => (k in window.__store ? window.__store[k] : d);
  window.GM_setValue = (k, v) => { window.__store[k] = v; };
  if (!window.__gmXhr) {
    window.__gmXhr = true;
    window.GM_xmlhttpRequest = (o) => {
      // Real fetch, so icons come from reddit like they do in production.
      fetch(o.url, { headers: o.headers || {} })
        .then((r) => r.text())
        .then((t) => o.onload && o.onload({ responseText: t, status: 200 }))
        .catch(() => o.onerror && o.onerror());
    };
  }
  const rw = console.warn.bind(console);
  console.warn = (...a) => { window.__warns.push(a.map(String).join(' ')); rw(...a); };
  window.addEventListener('error', (e) => window.__errors.push(String(e.message)));
  return 'stubbed';
})()
`);
  await b.evaluate(SCRIPT + '\n;("injected")');
}

/**
 * Hover an element with a REAL pointer move, not a synthetic event: synthetic
 * mouseover bypasses hit-testing, which is exactly how a "works in tests, dead
 * on the site" bug hides.
 */
async function hoverReal(selector) {
  const pt = await b.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  if (!pt) {
    console.log(`  (no element for ${selector})`);
    return;
  }
  // Move away first, so the pointer genuinely enters the target.
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 5, button: 'none' }, b.sessionId);
  await delayMs(150);
  await b.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, button: 'none' }, b.sessionId);
  console.log(`  hovered ${selector} at ${pt.x},${pt.y}`);
}

function delayMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
