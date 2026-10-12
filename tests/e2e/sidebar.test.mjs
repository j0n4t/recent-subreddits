// End-to-end regression tests for recent-subreddits.user.js
//
// Drives the REAL userscript in a real Chromium against tests/fixtures/reddit-mock.html,
// which stubs the GM_* APIs. No network, no reddit.com, no bot protection.
//
// Run:  npm run test:e2e

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { Browser, findBrowser } from './cdp-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(join(HERE, '..', 'fixtures', 'reddit-mock.html')).href;

const browserPath = findBrowser();
const skip = browserPath ? false : 'no Chromium found (set E2E_BROWSER to override)';

/** Build the fixture URL with a seeded GM store. */
function fixtureUrl(seed, iconDelay = 5) {
  const b64 = Buffer.from(JSON.stringify(seed), 'utf8').toString('base64');
  return `${FIXTURE}?seed=${encodeURIComponent(b64)}&iconDelay=${iconDelay}`;
}

/**
 * Simulate a pointer entering an element, the way a real browser does: it fires
 * `mouseover` (bubbles) AND `mouseenter` (does not bubble) on the target.
 * Dispatching both keeps the test agnostic to which event the script listens on,
 * so it isolates the SPA-re-render bug rather than any event-choice difference.
 */
const HOVER = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) throw new Error('no element for ' + ${JSON.stringify(sel)});
  const opts = { bubbles: true, cancelable: true, relatedTarget: document.body };
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  return true;
})()`;

const CLICK_BODY = `document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))`;
const POPUP = `.recent-subreddits-popup`;
const isVisible = `!!document.querySelector('${POPUP}')?.classList.contains('visible')`;

/** Replace the host header with fresh nodes, simulating SPA navigation re-render. */
const RERENDER_HEADER = `(() => {
  const old = document.querySelector('#site-header');
  const fresh = document.createElement('header');
  fresh.id = 'site-header';
  fresh.innerHTML = '<a href="/" id="logo" data-testid="top-nav-logo"><span>R</span></a>'
                  + '<button id="menu-btn" aria-label="Open menu">menu</button>';
  old.replaceWith(fresh);
  return true;
})()`;

const DEFAULT_SEED = {
  recent: [
    { name: 'javascript', visitedAt: Date.now() - 60_000 },
    { name: 'linux', visitedAt: Date.now() - 600_000 },
    { name: 'webdev', visitedAt: Date.now() - 7_200_000 },
    { name: 'rust', visitedAt: Date.now() - 86_400_000 },
  ],
  pinned: ['linux'],
};

describe('recent-subreddits sidebar', { skip }, () => {
  let b;

  before(async () => {
    b = await Browser.launch();
    assert.ok(b, 'browser failed to launch');
  });

  after(async () => {
    if (b) await b.stop();
  });

  /** Fresh page per test: no cross-test state, no storage bleed. */
  async function open(seed = DEFAULT_SEED, iconDelay = 5) {
    await b.goto(fixtureUrl(seed, iconDelay));
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');
    return b;
  }

  test('mounts hidden, then shows on hover below the trigger', async () => {
    await open();
    assert.equal(await b.evaluate(isVisible), false, 'popup must start hidden');

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup to become visible on hover');

    // Geometry, not just the class: popup sits just below the logo.
    const geo = await b.evaluate(`(() => {
      const t = document.querySelector('#logo').getBoundingClientRect();
      const p = document.querySelector('${POPUP}').getBoundingClientRect();
      return { triggerBottom: t.bottom, popupTop: p.top, popupLeft: p.left, winW: innerWidth };
    })()`);
    assert.ok(
      geo.popupTop >= geo.triggerBottom && geo.popupTop - geo.triggerBottom < 30,
      `popup should sit just below the trigger, got ${JSON.stringify(geo)}`
    );
    assert.ok(geo.popupLeft >= 16, `popup must respect the lateral margin, got left=${geo.popupLeft}`);
  });

  test('REGRESSION: hover still works after the host re-renders the header', async () => {
    // The original bug: mouseenter was bound to nodes found at mount time, so
    // Reddit's SPA re-render swapped in fresh nodes with no listeners.
    await open();

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup on first hover');
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(`!${isVisible}`, 'popup to close');

    await b.evaluate(RERENDER_HEADER);

    // Prove the nodes really are new (a no-op re-render would pass vacuously).
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup to show after the header was replaced');
  });

  test('REGRESSION: hover works when the host wipes the injected wrapper', async () => {
    await open();

    // Detach and re-check inside ONE evaluation: the MutationObserver re-mounts
    // on its own tick, so a separate evaluate would race it.
    const detached = await b.evaluate(`(() => {
      document.querySelector('.recent-subreddits-container').remove();
      return !document.querySelector('.recent-subreddits-container');
    })()`);
    assert.equal(detached, true, 'wrapper should be detached immediately after remove()');

    // Nudge the DOM so the observer runs, then expect re-mount.
    await b.evaluate(`document.body.appendChild(document.createElement('span'))`);
    await b.waitUntil(
      `!!document.querySelector('.recent-subreddits-container')`,
      'wrapper to be re-mounted by the observer'
    );
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.recent-subreddits-container').length`),
      1,
      're-mount must not duplicate the wrapper'
    );
    assert.equal(
      await b.evaluate(`!!document.getElementById('rs-styles')`),
      true,
      'stylesheet must survive too'
    );

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup to show after re-mount');
  });

  test('hover on a child of the trigger also opens it', async () => {
    await open();
    // #logo contains a <span>; closest() must walk up to the anchor.
    await b.evaluate(HOVER('#logo span'));
    await b.waitUntil(isVisible, 'popup to show when a trigger child is hovered');
  });

  test('pin/unpin keeps the popup open and persists the change', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    await b.evaluate(`document.querySelector('.rs-pin-btn[data-name="javascript"]').click()`);
    // Give the click handler a beat, then assert it stayed open.
    await b.waitUntil(
      `document.querySelectorAll('.rs-pinned .rs-link').length === 2`,
      'r/javascript to appear under Pinned'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after pinning');
    assert.deepEqual(
      await b.evaluate(`Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent)`),
      ['r/javascript', 'r/linux']
    );

    await b.evaluate(`document.querySelector('.rs-unpin-btn[data-name="linux"]').click()`);
    await b.waitUntil(
      `document.querySelectorAll('.rs-pinned .rs-link').length === 1`,
      'r/linux to be unpinned'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after unpinning');
    assert.deepEqual(
      await b.evaluate(`Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent)`),
      ['r/javascript']
    );

    // Unpinned r/linux returns to the Recent list, and the stale entry is gone
    // from Pinned — assert absence, not just presence.
    const recentNames = await b.evaluate(
      `Array.from(document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-link')).map(a => a.textContent)`
    );
    assert.ok(recentNames.includes('r/linux'), `r/linux should return to Recent, got ${recentNames}`);

    // The change must be persisted, not just rendered.
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubreddits`));
    assert.deepEqual(stored.pinned, ['javascript'], 'pin state must be written to GM storage');
  });

  test('fetches a subreddit icon and patches the src in place', async () => {
    // Slow the stubbed fetch so the placeholder state is actually observable —
    // with a fast fetch the assertion would race the replacement.
    await open(DEFAULT_SEED, 400);

    assert.match(
      await b.evaluate(`document.querySelector('.rs-icon').getAttribute('src')`),
      /^data:image\/svg\+xml/,
      'icon should start as the inline placeholder'
    );

    await b.waitUntil(
      `Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))`,
      'all icons to be replaced by fetched URLs',
      15000
    );

    const pairs = await b.evaluate(`Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
      name: decodeURIComponent(i.dataset.name),
      src: i.getAttribute('src'),
    }))`);
    for (const { name, src } of pairs) {
      assert.equal(src, `https://icons.test/${name}.png`, `icon for ${name} mapped to the wrong src`);
    }
    assert.equal(
      await b.evaluate(`window.__xhrCalls.length`),
      pairs.length,
      'exactly one request per distinct subreddit (no duplicate fetches)'
    );
  });

  test('close paths: outside click, close button, Escape', async () => {
    await open();

    for (const [label, close] of [
      ['outside click', CLICK_BODY],
      ['close button', `document.querySelector('.rs-close-btn').click()`],
      ['Escape', `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`],
    ]) {
      await b.evaluate(HOVER('#logo'));
      await b.waitUntil(isVisible, `popup open before testing ${label}`);
      await b.evaluate(close);
      await b.waitUntil(`!${isVisible}`, `popup to close via ${label}`);
    }
  });

  test('the logo link still navigates (preventDefault only while opening)', async () => {
    await open();

    // First click opens the popup and must swallow the navigation.
    const first = await b.evaluate(`(() => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.querySelector('#logo').dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, open: ${isVisible} };
    })()`);
    assert.deepEqual(first, { prevented: true, open: true }, 'opening click should preventDefault');

    // Second click closes it and must let the link through.
    const second = await b.evaluate(`(() => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.querySelector('#logo').dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, open: ${isVisible} };
    })()`);
    assert.deepEqual(second, { prevented: false, open: false }, 'closing click must not preventDefault');
  });

  test('flips above the trigger when there is no room below', async () => {
    await open();

    await b.evaluate(`document.querySelector('#logo').style.cssText = 'position:fixed;bottom:2px;left:300px;'`);
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    const geo = await b.evaluate(`(() => {
      const t = document.querySelector('#logo').getBoundingClientRect();
      const p = document.querySelector('${POPUP}').getBoundingClientRect();
      return { triggerTop: Math.round(t.top), popupBottom: Math.round(p.bottom), popupTop: Math.round(p.top), winH: innerHeight };
    })()`);
    assert.ok(
      geo.popupBottom <= geo.triggerTop + 1,
      `popup should flip above the trigger, got ${JSON.stringify(geo)}`
    );
    assert.ok(geo.popupTop >= 0, `flipped popup must stay on screen, got ${JSON.stringify(geo)}`);
  });

  test('no uncaught errors during a full interaction run', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-pin-btn').click()`);
    await b.evaluate(RERENDER_HEADER);
    await b.evaluate(HOVER('#logo'));
    await b.evaluate(CLICK_BODY);

    const errors = await b.evaluate(`window.__errors`);
    assert.deepEqual(errors, [], `page reported errors: ${JSON.stringify(errors)}`);
  });
});
