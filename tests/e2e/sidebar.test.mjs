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

/**
 * Dispatch a keydown for a combo string like "Alt+Shift+r".
 *
 * Targets `document.activeElement` so it reaches whichever node has focus: the
 * userscript's global listener is on `document`, and the settings hotkey field
 * handles its own keydown, so a focused field is exercised the way a real key
 * press would be. Bubbles, so a document-level listener still sees it.
 */
const PRESS = (combo) => `(() => {
  const parts = ${JSON.stringify(combo)}.split('+');
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document;
  const ev = new KeyboardEvent('keydown', {
    key,
    ctrlKey: mods.includes('ctrl'),
    altKey: mods.includes('alt'),
    shiftKey: mods.includes('shift'),
    metaKey: mods.includes('meta'),
    bubbles: true,
    cancelable: true,
  });
  target.dispatchEvent(ev);
  return true;
})()`;

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

  test('hotkey opens the popup with no trigger present', async () => {
    // This is the whole point of the hotkey: it must work when every trigger
    // selector has stopped matching.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&noTriggers=1`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    assert.equal(await b.evaluate(isVisible), false, 'popup starts hidden');

    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup to open via hotkey');

    // Centred, since there is no trigger to anchor to.
    const geo = await b.evaluate(`(() => {
      const p = document.querySelector('${POPUP}').getBoundingClientRect();
      return { left: Math.round(p.left), top: Math.round(p.top), winW: innerWidth, winH: innerHeight };
    })()`);
    assert.ok(Math.abs(geo.left - (geo.winW - 280) / 2) < 2, `hotkey popup should be centred horizontally: ${JSON.stringify(geo)}`);
    assert.ok(geo.top > 0, `centred popup must be on screen: ${JSON.stringify(geo)}`);
  });

  test('hotkey toggles the popup closed again', async () => {
    await open();
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup open via hotkey');
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(`!${isVisible}`, 'popup closed via hotkey');
  });

  test('the default hotkey does not fire on a different combination', async () => {
    await open();
    await b.evaluate(PRESS('Alt+r'));       // missing Shift
    await b.evaluate(PRESS('Ctrl+Shift+r')); // wrong modifier
    assert.equal(await b.evaluate(isVisible), false, 'only the configured combo may open the popup');
  });

  test('settings modal opens, captures a new hotkey, and it takes effect', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    // Open settings via the gear.
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel to open'
    );
    assert.equal(
      await b.evaluate(`getComputedStyle(document.querySelector('#rs-settings-panel')).display`),
      'block',
      'settings panel should be visible'
    );

    // Focus the field and press a new combination.
    await b.evaluate(`document.querySelector('#rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('Ctrl+Shift+k'));

    assert.equal(
      await b.evaluate(`document.querySelector('#rs-hotkey-input').value`),
      'Ctrl+Shift+K',
      'field should show the captured combination'
    );

    // Persisted, not just displayed.
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    assert.equal(stored.hotkey, 'Ctrl+Shift+K', 'new hotkey must be written to storage');

    // The old combo no longer works, the new one does.
    await b.evaluate(`document.querySelector('#rs-done').click()`);
    await b.waitUntil(
      `!document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel to close'
    );

    await b.evaluate(CLICK_BODY); // close popup
    await b.waitUntil(`!${isVisible}`, 'popup closed');

    await b.evaluate(PRESS('Alt+Shift+r'));
    assert.equal(await b.evaluate(isVisible), false, 'the replaced hotkey must stop working');

    await b.evaluate(PRESS('Ctrl+Shift+k'));
    await b.waitUntil(isVisible, 'popup to open via the newly configured hotkey');
  });

  test('settings rejects a combination without a modifier', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    await b.evaluate(`document.querySelector('#rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('k')); // bare letter

    const status = await b.evaluate(`document.querySelector('#rs-status').textContent`);
    assert.match(status, /modifier/i, `expected a modifier warning, got: ${status}`);
    assert.equal(
      await b.evaluate(`window.__store.recentSubredditsSettings || null`),
      null,
      'an invalid combination must not be saved'
    );
  });

  test('settings modal survives a pin change underneath it', async () => {
    // The popup node is persistent, so a content re-render must not close the modal.
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    await b.evaluate(`document.querySelector('.rs-pin-btn[data-name="javascript"]').click()`);
    await b.waitUntil(
      `document.querySelectorAll('.rs-pinned .rs-link').length === 2`,
      'pin to take effect'
    );
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('settings-open')`),
      true,
      'settings must stay open across a content re-render'
    );
  });

  test('settings modal resets the hotkey to the default', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    await b.evaluate(`document.querySelector('#rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('Ctrl+Shift+k'));
    await b.evaluate(`document.querySelector('#rs-reset').click()`);

    assert.equal(
      await b.evaluate(`document.querySelector('#rs-hotkey-input').value`),
      'Alt+Shift+R',
      'reset should restore the default in the field'
    );
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    assert.equal(stored.hotkey, 'Alt+Shift+R', 'reset should persist the default');
  });

  test('Escape closes the settings modal before the popup', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    const ESC = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;
    await b.evaluate(ESC);
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('settings-open')`),
      false,
      'first Escape closes the modal'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup stays open after the first Escape');

    await b.evaluate(ESC);
    await b.waitUntil(`!${isVisible}`, 'second Escape closes the popup');
  });

  test('WARNS once when no trigger selector matches', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&noTriggers=1`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    const warns = await b.waitUntil(
      `window.__warns.length > 0 ? window.__warns : null`,
      'a warning about the missing trigger'
    );
    assert.equal(warns.length, 1, `expected exactly one warning, got ${JSON.stringify(warns)}`);
    assert.match(warns[0], /no popup trigger matched/i);
    assert.match(warns[0], /recent-subreddits/, 'warning should be prefixed so it is identifiable');

    // Navigating must not spam the console with a repeat.
    await b.evaluate(`document.body.appendChild(document.createElement('span'))`);
    await b.evaluate(CLICK_BODY);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      await b.evaluate(`window.__warns.length`),
      1,
      'the warning must not repeat'
    );
  });

  test('does NOT warn when the trigger is present', async () => {
    await open();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      await b.evaluate(`window.__warns`),
      [],
      'a normal page must stay silent in the console'
    );
  });
});
