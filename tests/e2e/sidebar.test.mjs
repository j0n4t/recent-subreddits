// End-to-end regression tests for recent-subreddits.user.js
//
// Drives the REAL userscript in a real Chromium against tests/fixtures/reddit-mock.html,
// which stubs the GM_* APIs. No network, no reddit.com, no bot protection.
//
// Run:  npm run test:e2e

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { Browser, findBrowser, run } from './cdp-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = pathToFileURL(join(HERE, '..', 'fixtures', 'reddit-mock.html')).href;

const browserPath = findBrowser();
const skip = browserPath ? false : 'no Chromium found (set E2E_BROWSER to override)';

/** Build the fixture URL with a seeded GM store. */
function fixtureUrl(seed, iconDelay = 5, iconFail = null) {
  const b64 = Buffer.from(JSON.stringify(seed), 'utf8').toString('base64');
  const fail = iconFail ? `&iconFail=${encodeURIComponent(iconFail)}` : '';
  return `${FIXTURE}?seed=${encodeURIComponent(b64)}&iconDelay=${iconDelay}${fail}`;
}

/**
 * The built-in popup trigger, as it ships in defaults.js. Settings seeded in a
 * test must include it, because it is a normal settings entry now rather than a
 * hardcoded fallback — without it, hover on the fixture's logo opens nothing.
 */
const BUILTIN_HOOK = {
  selector: 'a[href="/"], #header-logo, .header-logo, [data-testid="top-nav-logo"], ' +
    'button[aria-label*="menu" i], #TopNav button, #reddit-logo, #navbar-menu-button',
  mode: 'hook',
  events: 'both',
};

/** A `settings=` query value: base64 of the JSON, matching the fixture's parser. */
function settingsParam(settings) {
  const json = JSON.stringify({
    hotkey: 'Alt+Shift+R',
    ...settings,
    // Seed the built-in hook only when the test does not bring its own targets.
    // Tests that pass targets address rows by index and assert exact lists, so an
    // extra seeded row would shift them; those open the popup by hotkey instead.
    targets: Array.isArray(settings.targets) ? settings.targets : [BUILTIN_HOOK],
  });
  return encodeURIComponent(Buffer.from(json, 'utf8').toString('base64'));
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
  async function open(seed = DEFAULT_SEED, iconDelay = 5, iconFail = null) {
    await b.goto(fixtureUrl(seed, iconDelay, iconFail));
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

  test('remove: the trash drops a subreddit from history and persists it', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    // Every recent row offers a trash; the Pinned section does not (it has its
    // own unpin control).
    const controls = await b.evaluate(`({
      recentRows: document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-item').length,
      trashes: document.querySelectorAll('.rs-remove-btn').length,
      trashesInPinned: document.querySelectorAll('.rs-pinned-section .rs-remove-btn').length,
    })`);
    assert.equal(controls.trashes, controls.recentRows, 'every recent row needs a trash');
    assert.equal(controls.trashesInPinned, 0, 'the pinned section must not get a trash');

    await b.evaluate(`document.querySelector('.rs-remove-btn[data-name="webdev"]').click()`);

    await b.waitUntil(
      `!Array.from(document.querySelectorAll('.rs-link')).some(a => a.textContent === 'r/webdev')`,
      'r/webdev to disappear from the list'
    );
    // No confirmation: one click, and it is gone.
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after removing');

    // Persisted, not just rendered — a reload must not bring it back.
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubreddits`));
    assert.deepEqual(
      stored.recent.map((r) => r.name),
      ['javascript', 'linux', 'rust'],
      'the removal must be written to GM storage'
    );
  });

  test('remove: a pinned subreddit is not in Recent, so it cannot be removed from there', async () => {
    // The trash is a history control. r/linux is pinned, so it is filtered out of
    // Recent and only the unpin control applies to it.
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    const state = await b.evaluate(`({
      linuxTrash: !!document.querySelector('.rs-remove-btn[data-name="linux"]'),
      linuxInRecent: Array.from(document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-link'))
        .some(a => a.textContent === 'r/linux'),
      linuxPinned: Array.from(document.querySelectorAll('.rs-pinned .rs-link'))
        .some(a => a.textContent === 'r/linux'),
    })`);
    assert.equal(state.linuxInRecent, false, 'a pinned subreddit must not be listed under Recent');
    assert.equal(state.linuxPinned, true, 'r/linux should be pinned in this fixture');
    assert.equal(state.linuxTrash, false, 'a pinned subreddit must not offer a trash');
  });

  test('remove: emptying the history shows the empty state', async () => {
    // The fixture pins r/linux, so clearing Recent must leave only the Pinned
    // section — no "no subreddits visited yet" line, because the list is not empty.
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    for (const name of ['javascript', 'webdev', 'rust']) {
      await b.evaluate(`document.querySelector('.rs-remove-btn[data-name="${name}"]').click()`);
      await b.waitUntil(
        `!document.querySelector('.rs-remove-btn[data-name="${name}"]')`,
        `r/${name} to be removed`
      );
    }

    const state = await b.evaluate(`({
      recentSection: !!document.querySelector('.rs-section:not(.rs-pinned-section)'),
      pinned: Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent),
      empty: !!document.querySelector('.rs-empty'),
      stored: JSON.parse(window.__store.recentSubreddits).recent.map(r => r.name),
    })`);
    assert.deepEqual(state.pinned, ['r/linux'], 'the pin must survive a history clear');
    assert.equal(state.recentSection, false, 'the Recent section should be gone once empty');
    assert.equal(state.empty, false, 'a non-empty Pinned list must not show the empty state');
    // r/linux stays in the stored recent list: pinning does not remove it, the
    // render just filters pinned names out of the Recent section. Unpinning puts
    // it back, which the pin/unpin test covers.
    assert.deepEqual(state.stored, ['linux'], 'only the pinned entry should remain in storage');
  });

  test('blacklist: the trash adds the subreddit to the blacklist in settings', async () => {
    // The trash does two things: drop the row, and blacklist the subreddit so it
    // cannot come back. (That a blocked subreddit is not TRACKED again is a unit
    // test — see the "visit tracking" suite — because the fixture is a file://
    // page and so has no subreddit URL for the tracker to read.)
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-blocked-list').length`),
      0,
      'the blacklist UI only exists inside the settings panel'
    );

    await b.evaluate(`document.querySelector('.rs-remove-btn[data-name="webdev"]').click()`);
    await b.waitUntil(
      `!document.querySelector('.rs-remove-btn[data-name="webdev"]')`,
      'r/webdev to be removed'
    );

    const blocked = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`)).blocked;
    assert.deepEqual(blocked, ['webdev'], 'the removal must blacklist the subreddit');
  });

  test('blacklist: settings shows the blocklist as a textarea, one name per line', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev,rust`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    const state = await b.evaluate(`(() => {
      const ta = document.querySelector('.rs-blocked-input');
      const cs = getComputedStyle(ta);
      return {
        tag: ta.tagName,
        value: ta.value,
        lines: ta.value.split('\\n'),
        // Must be a real multi-line field, not a text input.
        rows: ta.rows,
        height: Math.round(ta.getBoundingClientRect().height),
        resizable: cs.resize,
        // The old per-row list must be gone.
        oldList: !!document.querySelector('.rs-blocked-list'),
      };
    })()`);

    assert.equal(state.tag, 'TEXTAREA', 'the blocklist must be a textarea');
    assert.deepEqual(state.lines, ['webdev', 'rust'], 'one subreddit per line, in order');
    assert.equal(state.oldList, false, 'the old per-row list must be gone');
    assert.ok(state.height > 40, `a textarea must be multi-line, got ${state.height}px`);
    assert.equal(state.resizable, 'vertical', 'it should be user-resizable');
  });

  test('blacklist: editing the textarea saves the blocklist and re-enables tracking', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev,rust`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    // Delete r/rust's line and add two more — the real edit path: type, then
    // blur (which is what fires `change`).
    await b.evaluate(`(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.value = 'webdev\\n  Linux  \\nr/webdev\\n';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    const stored = JSON.parse(
      await b.evaluate(`window.__store.recentSubredditsSettings`)
    ).blocked;
    // Normalized: trimmed, lowercased, r/ prefix stripped, duplicates dropped,
    // blank lines ignored.
    assert.deepEqual(stored, ['webdev', 'linux'], `blocklist must be normalized, got ${JSON.stringify(stored)}`);

    // The field itself keeps what was typed (not re-rendered underneath the user).
    assert.equal(
      await b.evaluate(`document.querySelector('.rs-blocked-input').value`),
      'webdev\n  Linux  \nr/webdev\n',
      'the textarea must not be rewritten while the user is editing'
    );
  });

  test('blacklist: clearing the textarea clears the blocklist', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    await b.evaluate(`(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.value = '';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    assert.deepEqual(
      JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`)).blocked,
      [],
      'an empty textarea must clear the blocklist'
    );
  });

  test('blacklist: typing in the textarea does not fire the global hotkey', async () => {
    // The panel's field must swallow its keys: the hotkey handler is on
    // `document`, and a bare letter typed here must not be read as a shortcut.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    // The default hotkey is Alt+Shift+R; press it inside the field.
    await b.evaluate(`(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'r', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      return true;
    })()`);

    assert.equal(await b.evaluate(isVisible), true, 'the popup must not toggle from a key in the field');
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('settings-open')`),
      true,
      'settings must stay open'
    );
  });

  test('remove: works from an inline block too', async () => {
    // The inline instances are a second mount of the same list, so a trash that
    // only worked in the popup would be a dead control there.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    await b.evaluate(`document.querySelector('.rs-inline .rs-remove-btn[data-name="rust"]').click()`);
    await b.waitUntil(
      `!document.querySelector('.rs-inline .rs-remove-btn[data-name="rust"]')`,
      'r/rust to disappear from the inline block'
    );

    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubreddits`));
    assert.ok(
      !stored.recent.some((r) => r.name === 'rust'),
      `the inline removal must persist, got ${JSON.stringify(stored.recent.map((r) => r.name))}`
    );
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

  test('REGRESSION: a transient icon 403 is retried, not cached as a grey circle', async () => {
    // Live reddit answers about.json with a 403 + an HTML body ("blocked by
    // network security") under rate limiting — measured per-subreddit and
    // time-varying. The old code read no status, so the HTML failed JSON.parse,
    // the catch swallowed it, and the placeholder was cached FOREVER: the icon
    // stayed a grey circle for the life of the page and no later render retried
    // it. That is the bug this pins down.
    await open(DEFAULT_SEED, 5, 'javascript:1,linux:2');

    await b.waitUntil(
      `Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))`,
      'every icon to recover after a transient 403',
      25000
    );

    const state = await b.evaluate(`(() => ({
      attempts: window.__iconAttempts,
      srcs: Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
        name: decodeURIComponent(i.dataset.name),
        src: i.getAttribute('src'),
      })),
    }))()`);

    // Retried: the failing subreddits got extra attempts...
    assert.ok(
      state.attempts.javascript >= 2,
      `r/javascript should have been retried after its 403, got ${JSON.stringify(state.attempts)}`
    );
    assert.ok(
      state.attempts.linux >= 3,
      `r/linux should have been retried twice after two 403s, got ${JSON.stringify(state.attempts)}`
    );
    // ...while a subreddit that succeeded on the first try was not re-fetched.
    assert.equal(
      state.attempts.webdev,
      1,
      `a subreddit that succeeded must not be re-fetched, got ${JSON.stringify(state.attempts)}`
    );

    // And it recovered to the REAL icon, not the placeholder.
    for (const { name, src } of state.srcs) {
      assert.equal(src, `https://icons.test/${name}.png`, `icon for ${name} never recovered`);
    }
  });

  test('icon requests are serialized, not fired as a burst', async () => {
    // Live reddit rate-limits about.json, so one request per row all at once is
    // what provokes the 403s in the first place. Requests must be spaced out.
    await open(DEFAULT_SEED, 5);

    await b.waitUntil(
      `Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))`,
      'all icons to load',
      20000
    );

    const timing = await b.evaluate(`(() => {
      const t = window.__xhrTimes || [];
      const gaps = [];
      for (let i = 1; i < t.length; i++) gaps.push(Math.round(t[i] - t[i - 1]));
      return { count: t.length, gaps, minGap: gaps.length ? Math.min(...gaps) : null };
    })()`);

    assert.ok(timing.count > 1, `expected several icon requests, got ${timing.count}`);
    assert.ok(
      timing.minGap >= 50,
      `icon requests must be spaced apart, got gaps ${JSON.stringify(timing.gaps)}`
    );
  });

  test('HARVEST: the current subreddit icon is adopted from the page, with no fetch', async () => {
    // This is how reddit's own recent-communities list works: the subreddit's
    // icon is already in the page, so there is nothing to request. The icon URL
    // here is a distinct harvest-only URL, so adopting it can only have come
    // from the DOM.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&sub=javascript`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    const harvested = await b.evaluate(`(() => {
      const img = Array.from(document.querySelectorAll('.rs-icon'))
        .find(i => decodeURIComponent(i.dataset.name) === 'javascript');
      return { src: img ? img.getAttribute('src') : null, harvestUrl: window.__harvestIconUrl };
    })()`);
    assert.equal(
      harvested.src,
      harvested.harvestUrl,
      'the current subreddit icon must be adopted from the page'
    );

    // And it must NOT have been fetched: that is the whole point.
    const fetched = await b.evaluate(
      `window.__xhrCalls.filter(u => /\\/r\\/javascript\\/about\\.json/.test(u)).length`
    );
    assert.equal(fetched, 0, 'a harvested icon must not also trigger an about.json fetch');

    // Other rows still need the fallback, so they do fetch.
    assert.ok(
      (await b.evaluate(`window.__xhrCalls.length`)) > 0,
      'subreddits without a harvestable icon must still use the fallback'
    );
  });

  test('HARVEST: a stale anchor is never filed under the wrong subreddit', async () => {
    // Measured on live reddit: after a subreddit-to-subreddit navigation the URL
    // is already the new route while the icon anchor still holds the PREVIOUS
    // subreddit's icon for ~1s. Here the URL says r/linux while the page's header
    // still names r/javascript — the mid-navigation state. The harvest must
    // refuse, not guess, or r/javascript's icon lands on r/linux's row.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&sub=linux&subStale=javascript`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    const state = await b.evaluate(`(() => {
      const rows = Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
        name: decodeURIComponent(i.dataset.name),
        src: i.getAttribute('src'),
      }));
      return { rows, harvestUrl: window.__harvestIconUrl };
    })()`);

    // The header names r/javascript, so the icon is filed there — never on
    // r/linux's row, even though the URL says linux.
    const javascript = state.rows.find((r) => r.name === 'javascript');
    assert.equal(
      javascript.src,
      state.harvestUrl,
      "the icon must be filed under the page's own name, not the URL"
    );

    const wrong = state.rows.filter((r) => r.name !== 'javascript' && r.src === state.harvestUrl);
    assert.deepEqual(
      wrong,
      [],
      `a stale anchor must not be filed under another subreddit, got ${JSON.stringify(wrong)}`
    );
  });

  test('HARVEST: a foreign URL in the anchor is not adopted', async () => {
    // The anchor is reddit's, but nothing stops a stray <img> from being the
    // first match. Only reddit's image CDN may be adopted.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&sub=javascript`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    const adopted = await b.evaluate(`(() => {
      // Poison the anchor with a non-reddit URL, then force a harvest by opening
      // the popup (which harvests before showing).
      const el = document.querySelector('#subreddit-icon-img img');
      el.setAttribute('src', 'https://evil.example.com/icon.png');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      const img = Array.from(document.querySelectorAll('.rs-icon'))
        .find(i => decodeURIComponent(i.dataset.name) === 'javascript');
      return img ? img.getAttribute('src') : null;
    })()`);
    assert.ok(
      !String(adopted).includes('evil.example.com'),
      `a non-redditmedia URL must never be adopted, got ${adopted}`
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
      await b.evaluate(`getComputedStyle(document.querySelector('.rs-settings-panel')).display`),
      'block',
      'settings panel should be visible'
    );

    // Focus the field and press a new combination.
    await b.evaluate(`document.querySelector('.rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('Ctrl+Shift+k'));

    assert.equal(
      await b.evaluate(`document.querySelector('.rs-hotkey-input').value`),
      'Ctrl+Shift+K',
      'field should show the captured combination'
    );

    // Persisted, not just displayed.
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    assert.equal(stored.hotkey, 'Ctrl+Shift+K', 'new hotkey must be written to storage');

    // The old combo no longer works, the new one does.
    await b.evaluate(`document.querySelector('[data-role="done"]').click()`);
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

    await b.evaluate(`document.querySelector('.rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('k')); // bare letter

    const status = await b.evaluate(`document.querySelector('.rs-status').textContent`);
    assert.match(status, /modifier/i, `expected a modifier warning, got: ${status}`);
    assert.equal(
      JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`)).hotkey,
      'Alt+Shift+R',
      'an invalid combination must not replace the hotkey'
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

    await b.evaluate(`document.querySelector('.rs-hotkey-input').focus()`);
    await b.evaluate(PRESS('Ctrl+Shift+k'));
    await b.evaluate(`document.querySelector('[data-role="reset"]').click()`);

    assert.equal(
      await b.evaluate(`document.querySelector('.rs-hotkey-input').value`),
      'Alt+Shift+R',
      'reset should restore the default in the field'
    );
    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    assert.equal(stored.hotkey, 'Alt+Shift+R', 'reset should persist the default');
  });

  test('header shows the back button and "Settings" title, gear hidden, and back returns', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    // List view: main icon+title, no back button, gear present.
    const list = await b.evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: q('.rs-header').textContent,
        back: getComputedStyle(q('.rs-back-btn')).display,
        gear: getComputedStyle(q('.rs-settings-btn')).display,
      };
    })()`);
    assert.equal(list.title, '📋 Recent Subreddits', 'list view should show the main icon+title');
    assert.equal(list.back, 'none', 'back button must be hidden in the list view');
    assert.notEqual(list.gear, 'none', 'gear must be visible in the list view');

    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    // Settings view: title swapped, back visible, gear hidden (redundant).
    const settings = await b.evaluate(`(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: q('.rs-header').textContent,
        back: getComputedStyle(q('.rs-back-btn')).display,
        gear: getComputedStyle(q('.rs-settings-btn')).display,
      };
    })()`);
    assert.equal(settings.title, '⚙ Settings', 'settings view should show its own icon+title');
    assert.notEqual(settings.back, 'none', 'back button must be visible in settings');
    assert.equal(settings.gear, 'none', 'gear is redundant next to the Settings title and must be hidden');

    // The back button is the way out, and it restores the list view.
    await b.evaluate(`document.querySelector('.rs-back-btn').click()`);
    await b.waitUntil(
      `!document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'back button to close the settings panel'
    );
    assert.equal(
      await b.evaluate(`document.querySelector('.rs-header').textContent`),
      '📋 Recent Subreddits',
      'back must restore the main title'
    );
    assert.equal(await b.evaluate(isVisible), true, 'back must not close the popup itself');
  });

  test('close button sits at the end of the header row, aligned with the popup edge', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');

    const geo = await b.evaluate(`(() => {
      const popup = document.querySelector('${POPUP}');
      const close = document.querySelector('.rs-close-btn');
      const title = document.querySelector('.rs-header');
      const gear = document.querySelector('.rs-settings-btn');
      const row = document.querySelector('.rs-header-row');
      const p = popup.getBoundingClientRect();
      const c = close.getBoundingClientRect();
      const t = title.getBoundingClientRect();
      const g = gear.getBoundingClientRect();
      return {
        closeRight: c.right,
        contentRight: p.right - 14,
        closeCenterY: c.top + c.height / 2,
        titleCenterY: t.top + t.height / 2,
        closeLeft: c.left,
        gearRight: g.right,
        // The properties the change actually made: in-flow, and last on the row.
        position: getComputedStyle(close).position,
        isLastChild: row.lastElementChild === close,
        childOrder: Array.from(row.children).map((el) => el.className),
      };
    })()`);

    // The core of the change: the close button is a flex item on the header row,
    // not an absolutely-positioned glyph floating over the popup corner.
    assert.equal(geo.position, 'static', 'close button must be in the header row flow, not absolute');
    assert.equal(geo.isLastChild, true, `close must be the last control on the row, got ${geo.childOrder}`);

    // It is pushed to the row's right end, so it clears the gear.
    assert.ok(geo.closeLeft > geo.gearRight, `close must sit after the gear, got ${JSON.stringify(geo)}`);

    // Vertically centred with the title — this is what the old absolute
    // `top: 6px` positioning failed (it rode ~8px high).
    assert.ok(
      Math.abs(geo.closeCenterY - geo.titleCenterY) <= 3,
      `close button should be vertically centred with the title, got ${JSON.stringify(geo)}`
    );
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

  // ---- Live element picker ----

  test('picker: hovering outlines an element and clicking adds it as a hook target', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    // Start picking. The popup must get out of the way so the page is pickable.
    await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
    await b.waitUntil(
      `!!document.getElementById('rs-picker-hint')`,
      'picker overlay to appear'
    );
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('visible')`),
      false,
      'the popup must close so the whole page can be picked'
    );

    // Hover the target: the outline box follows it and the hint names a selector.
    await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      return true;
    })()`);
    const hovered = await b.evaluate(`(() => {
      const box = document.getElementById('rs-picker-box');
      const hint = document.getElementById('rs-picker-hint');
      const r = document.querySelector('#pick-target').getBoundingClientRect();
      return {
        display: getComputedStyle(box).display,
        boxW: Math.round(box.getBoundingClientRect().width),
        targetW: Math.round(r.width),
        hint: hint.textContent,
      };
    })()`);
    assert.equal(hovered.display, 'block', 'the outline box must be shown while hovering');
    assert.ok(
      Math.abs(hovered.boxW - hovered.targetW) <= 2,
      `outline must match the hovered element, got ${JSON.stringify(hovered)}`
    );
    assert.match(hovered.hint, /pick-target/, `hint should name the selector, got: ${hovered.hint}`);

    // Click it: the pick is taken, the overlay goes away, the target is stored.
    const picked = await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return {
        prevented: ev.defaultPrevented,
        overlayGone: !document.getElementById('rs-picker-hint') && !document.getElementById('rs-picker-box'),
      };
    })()`);
    assert.equal(picked.prevented, true, 'the pick click must be swallowed, not passed to the page');
    assert.equal(picked.overlayGone, true, 'the picker overlay must be removed after a pick');

    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    assert.deepEqual(
      stored.targets,
      [BUILTIN_HOOK, { selector: '#pick-target', mode: 'hook', events: 'both' }],
      'the picked element must be saved as a hook target'
    );

    // The settings UI came back and lists it.
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('settings-open')`),
      true,
      'settings must reopen after a pick'
    );
    assert.equal(
      await b.evaluate(`Array.from(document.querySelectorAll('.rs-target-sel')).map(c => c.textContent).at(-1)`),
      '#pick-target',
      'the target must be listed in settings'
    );
  });

  test('picker: Escape cancels without adding a target', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
    await b.waitUntil(`!!document.getElementById('rs-picker-hint')`, 'picker active');

    await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await b.waitUntil(
      `!document.getElementById('rs-picker-hint')`,
      'picker overlay to be removed by Escape'
    );

    assert.deepEqual(
      JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`)).targets,
      [BUILTIN_HOOK],
      'cancelling must not add a target'
    );
    assert.equal(
      await b.evaluate(`document.querySelector('${POPUP}').classList.contains('settings-open')`),
      true,
      'settings must come back after cancelling'
    );
  });

  test('picker: an already-configured element is not added twice', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings panel open'
    );

    // Pick the same element twice.
    for (let i = 0; i < 2; i++) {
      await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
      await b.waitUntil(`!!document.getElementById('rs-picker-hint')`, `picker active (${i})`);
      await b.evaluate(`(() => {
        const el = document.querySelector('#pick-target');
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      await b.waitUntil(`!document.getElementById('rs-picker-hint')`, `picker closed (${i})`);
    }

    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubredditsSettings`));
    // One seeded built-in hook + exactly one picked entry.
    assert.equal(stored.targets.length, 2, `duplicate pick must not add a second entry, got ${JSON.stringify(stored.targets)}`);
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-target').length`),
      2,
      'the list must show the built-in hook plus the single picked row'
    );
  });

  test('selector builder prefers an id, then a test id, then a path', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    // Read the selector the picker proposes for an element, without committing it.
    const propose = async (sel) => {
      await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
      await b.waitUntil(`!!document.getElementById('rs-picker-hint')`, 'picker active');
      const text = await b.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        return document.getElementById('rs-picker-hint').textContent;
      })()`);
      await b.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await b.waitUntil(`!document.getElementById('rs-picker-hint')`, 'picker closed');
      return text.replace(/\s+—.*$/, '').trim();
    };

    // An element with a usable id: the id wins.
    assert.equal(await propose('#pick-target'), '#pick-target', 'a unique id should win');

    // An element with only a data-testid (no id): the test id wins.
    assert.equal(
      await propose('[data-testid="testid-only"]'),
      '[data-testid="testid-only"]',
      'an element with no id should fall back to its data-testid'
    );

    // A deep child with no id and no test id: an nth-of-type path.
    const path = await propose('#content .hashed-x1y2z3 .leaf');
    assert.match(path, /span/, `a path selector should be produced, got: ${path}`);
    assert.ok(path.includes('>'), `expected a descendant path, got: ${path}`);
  });

  test('hook target: hover opens the popup from a non-built-in element', async () => {
    // Seed a hook target on #pick-target, which matches no built-in trigger.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'hook', events: 'both' }] })
    );
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup mounted');

    assert.equal(await b.evaluate(isVisible), false, 'popup starts hidden');

    await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      const o = { bubbles: true, cancelable: true, relatedTarget: document.body };
      el.dispatchEvent(new MouseEvent('mouseover', o));
      return true;
    })()`);
    await b.waitUntil(isVisible, 'popup to open from the hooked element');

    // Anchored to the hooked element, not centred.
    const geo = await b.evaluate(`(() => {
      const t = document.querySelector('#pick-target').getBoundingClientRect();
      const p = document.querySelector('${POPUP}').getBoundingClientRect();
      return { triggerBottom: t.bottom, popupTop: p.top };
    })()`);
    assert.ok(
      geo.popupTop >= geo.triggerBottom - 1 && geo.popupTop - geo.triggerBottom < 30,
      `popup should anchor below the hooked element, got ${JSON.stringify(geo)}`
    );
  });

  test('hook target: events=hover ignores clicks, events=click ignores hover', async () => {
    const hoverTarget = `(() => {
      const el = document.querySelector('#pick-target');
      const o = { bubbles: true, cancelable: true, relatedTarget: document.body };
      el.dispatchEvent(new MouseEvent('mouseover', o));
      return true;
    })()`;

    const clickTarget = `document.querySelector('#pick-target').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`;

    const seed = (events) =>
      fixtureUrl(DEFAULT_SEED) +
      '&settings=' +
      settingsParam({ targets: [{ selector: '#pick-target', mode: 'hook', events }] });

    // --- hover only ---
    await b.goto(seed('hover'));
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'mounted');
    await b.evaluate(clickTarget);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await b.evaluate(isVisible), false, 'a hover-only hook must ignore clicks');

    await b.evaluate(hoverTarget);
    await b.waitUntil(isVisible, 'hover-only hook opens on hover');

    // --- click only ---
    await b.goto(seed('click'));
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'mounted');
    await b.evaluate(hoverTarget);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await b.evaluate(isVisible), false, 'a click-only hook must ignore hover');

    await b.evaluate(clickTarget);
    await b.waitUntil(isVisible, 'click-only hook opens on click');
  });

  test('changing a target mode to replace persists it', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    // Pick an element, then switch its mode.
    await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
    await b.waitUntil(`!!document.getElementById('rs-picker-hint')`, 'picker active');
    await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await b.waitUntil(`!document.getElementById('rs-picker-hint')`, 'picker closed');

    const changed = await b.evaluate(`(() => {
      // The last row is the one just picked; the seeded built-in hook is first.
      const sels = document.querySelectorAll('[data-role="mode"]');
      const sel = sels[sels.length - 1];
      sel.value = 'replace';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    assert.equal(changed, true);

    await b.waitUntil(
      `JSON.parse(window.__store.recentSubredditsSettings).targets[1].mode === 'replace'`,
      'the mode change to be persisted'
    );

    // A replace target has no event choice — the control is gone for that row,
    // while the built-in hook above it still has one.
    assert.equal(
      await b.evaluate(`(() => {
        const rows = Array.from(document.querySelectorAll('.rs-target'));
        const last = rows[rows.length - 1];
        return last.querySelector('[data-role="events"]') === null;
      })()`),
      true,
      'the events selector must not be offered for a non-hook mode'
    );
  });

  test('removing a target persists the removal', async () => {
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    await b.evaluate(`document.querySelector('[data-role="pick"]').click()`);
    await b.waitUntil(`!!document.getElementById('rs-picker-hint')`, 'picker active');
    await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await b.waitUntil(`document.querySelectorAll('.rs-target').length === 2`, 'target listed');

    // Remove the picked row (the last one); the built-in hook stays.
    await b.evaluate(`(() => {
      const btns = document.querySelectorAll('[data-role="remove"]');
      btns[btns.length - 1].click();
      return true;
    })()`);
    await b.waitUntil(
      `JSON.parse(window.__store.recentSubredditsSettings).targets.length === 1`,
      'the removal to be persisted'
    );
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-target').length`),
      1,
      'the row must disappear'
    );
  });

  test('a malformed stored target is dropped, not fatal', async () => {
    const bad = settingsParam({
      targets: [
        null,
        { mode: 'hook' },                                    // no selector
        { selector: '   ' },                                 // blank selector
        { selector: '#pick-target', mode: 'nonsense' },       // bad mode
        { selector: '#logo', mode: 'hook', events: 'nope' },  // bad events
      ],
    });
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&settings=${bad}`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup mounted');

    // Two survive, each repaired to a valid mode/events.
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    const rows = await b.evaluate(`Array.from(document.querySelectorAll('.rs-target')).map(li => ({
      sel: li.querySelector('.rs-target-sel').textContent,
      mode: li.querySelector('[data-role="mode"]').value,
      events: li.querySelector('[data-role="events"]')?.value ?? null,
    }))`);
    assert.deepEqual(
      rows,
      [
        { sel: '#pick-target', mode: 'hook', events: 'both' },
        { sel: '#logo', mode: 'hook', events: 'both' },
      ],
      `malformed entries should be dropped and the rest repaired, got ${JSON.stringify(rows)}`
    );

    assert.deepEqual(await b.evaluate(`window.__errors`), [], 'a bad store must not throw');
  });

  // ---- Inline modes (replace / prepend / append) ----

  test('inline replace: hides the element, nests the UI inside it without leaving a gap, keeps the binding alive', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const state = await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      const host = document.querySelector('.rs-inline-host');
      return {
        elVisibility: getComputedStyle(el).visibility,
        elStillInDom: document.body.contains(el),
        // The block nests INSIDE the element (absolutely positioned, overlapping
        // it) so no gap is left in the document flow.
        hostInsideEl: el.contains(host),
        listItems: host.querySelectorAll('.rs-item').length,
        // The whole UI came along: header + gear + close.
        hasHeader: !!host.querySelector('.rs-header'),
        hasGear: !!host.querySelector('.rs-settings-btn'),
        hasClose: !!host.querySelector('.rs-close-btn'),
      };
    })()`);

    assert.equal(state.elVisibility, 'hidden', 'replace must hide the picked element');
    assert.equal(state.elStillInDom, true, 'replace must NOT remove the element from the DOM');
    assert.equal(state.hostInsideEl, true, 'the block must be nested inside the element to avoid a flow gap');
    assert.ok(state.listItems > 0, `the inline block must render the list, got ${state.listItems}`);
    assert.equal(state.hasHeader, true, 'the inline block must carry the header');
    assert.equal(state.hasGear, true, 'the inline block must carry the settings gear');
    assert.equal(state.hasClose, true, 'the inline block must carry the close control');
  });

  test('inline replace: adopts the replaced element width', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const widths = await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      // Measure the element while it is still laid out (visibility, not display).
      const w = el.getBoundingClientRect().width;
      const inst = document.querySelector('.rs-inline');
      return { elW: Math.round(w), instW: Math.round(inst.getBoundingClientRect().width), css: inst.style.width };
    })()`);
    assert.equal(widths.css, `${widths.elW}px`, 'the block should adopt the element width');
    // The instance is wider by the padding (6px each side = 12px total).
    assert.ok(
      Math.abs(widths.instW - widths.elW - 12) <= 1,
      `the rendered block should match the element width plus padding, got ${JSON.stringify(widths)}`
    );
  });

  test('inline replace: the block renders over the element it replaced, not at the page origin', async () => {
    // A replace host is position:absolute, so its containing block is the
    // nearest POSITIONED ancestor. The picked element is usually static (and so
    // are its ancestors), which sends the block to the page origin while the
    // element it replaced is hidden — the user sees a blank gap and a stray
    // panel. Structure assertions cannot see this; only geometry can.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const geo = await b.evaluate(`(() => {
      const el = document.querySelector('#pick-target');
      const inst = document.querySelector('.rs-inline');
      const eb = el.getBoundingClientRect();
      const ib = inst.getBoundingClientRect();
      const cx = Math.round(eb.left + eb.width / 2);
      const cy = Math.round(eb.top + eb.height / 2);
      // The decisive question: what is painted where the element was?
      const hit = document.elementFromPoint(cx, cy);
      return {
        el: { t: Math.round(eb.top), l: Math.round(eb.left), w: Math.round(eb.width), h: Math.round(eb.height) },
        block: { t: Math.round(ib.top), l: Math.round(ib.left), w: Math.round(ib.width), h: Math.round(ib.height) },
        dx: Math.round(ib.left - eb.left),
        dy: Math.round(ib.top - eb.top),
        hitIsBlock: !!hit && (inst === hit || inst.contains(hit)),
        hitTag: hit ? hit.tagName.toLowerCase() + (hit.id ? '#' + hit.id : '') : null,
      };
    })()`);

    assert.ok(
      Math.abs(geo.dx) <= 2 && Math.abs(geo.dy) <= 2,
      `the block must render over the element it replaced, got ${JSON.stringify(geo)}`
    );
    assert.equal(
      geo.hitIsBlock,
      true,
      `a click at the replaced element's centre must land on the block, got ${geo.hitTag}`
    );
  });

  test('inline replace: makes a static element a containing block, and undoes it on teardown', async () => {
    // The mechanism behind the test above: a static element cannot contain an
    // absolutely-positioned child, so the mount promotes it to `relative` — and
    // must put it back, or the host page keeps a stacking/containing change it
    // never asked for.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    assert.equal(
      await b.evaluate(`getComputedStyle(document.querySelector('#pick-target')).position`),
      'relative',
      'a static replace target must be promoted to a containing block'
    );

    // Drop the binding: the element goes back to how the page had it.
    await b.evaluate(`document.querySelector('.rs-inline .rs-close-btn').click()`);
    await b.waitUntil(`!document.querySelector('.rs-inline-host')`, 'the block to be removed');

    assert.equal(
      await b.evaluate(`document.querySelector('#pick-target').style.position`),
      '',
      'the promoted position must be reverted on teardown'
    );
    assert.equal(
      await b.evaluate(`getComputedStyle(document.querySelector('#pick-target')).position`),
      'static',
      'the element must return to its original static position'
    );
  });

  test('inline replace: does NOT override a target that already positions itself', async () => {
    // An element the page already positioned must keep its own value. The
    // fixture sets this one to `relative` as an inline style, so the check is
    // that we did not *replace* it — and that teardown leaves it intact.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#positioned-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    assert.equal(
      await b.evaluate(`document.querySelector('#positioned-target').style.position`),
      'relative',
      "the page's own positioning must be left exactly as it was"
    );
    // And the block still lands on it — no promotion was needed.
    const geo = await b.evaluate(`(() => {
      const el = document.querySelector('#positioned-target').getBoundingClientRect();
      const inst = document.querySelector('.rs-inline').getBoundingClientRect();
      return { dx: Math.round(inst.left - el.left), dy: Math.round(inst.top - el.top) };
    })()`);
    assert.ok(
      Math.abs(geo.dx) <= 2 && Math.abs(geo.dy) <= 2,
      `the block must overlap an already-positioned element, got ${JSON.stringify(geo)}`
    );

    // Teardown must not clear a value it did not set.
    await b.evaluate(`document.querySelector('.rs-inline .rs-close-btn').click()`);
    await b.waitUntil(`!document.querySelector('.rs-inline-host')`, 'the block to be removed');
    assert.equal(
      await b.evaluate(`document.querySelector('#positioned-target').style.position`),
      'relative',
      'teardown must not strip positioning the page set itself'
    );
  });

  test('inline replace: hides content that re-declares visibility:visible', async () => {
    // Reddit's login rail contains a descendant with an explicit
    // visibility:visible, which OVERRIDES an ancestor's visibility:hidden. So
    // hiding the target alone left the login prompt painted over the block.
    // This is the fixture's reproduction of that; it fails without the
    // .rs-replacing !important rule.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#override-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const state = await b.evaluate(`(() => {
      const inner = document.querySelector('#override-inner');
      const block = document.querySelector('.rs-inline');
      const ib = block.getBoundingClientRect();
      // Probe where the replaced content would be drawn.
      const hit = document.elementFromPoint(
        Math.round(ib.left + ib.width / 2),
        Math.round(ib.top + ib.height / 2)
      );
      return {
        targetMarked: document.querySelector('#override-target').classList.contains('rs-replacing'),
        innerVisibility: getComputedStyle(inner).visibility,
        blockVisibility: getComputedStyle(block).visibility,
        blockBackground: getComputedStyle(block).backgroundColor,
        // The decisive test: what is painted at the block's location?
        hitIsBlock: !!hit && (block === hit || block.contains(hit)),
        hitText: hit ? (hit.innerText || '').slice(0, 40) : null,
      };
    })()`);

    assert.equal(state.targetMarked, true, 'the target must carry the replace marker');
    assert.equal(
      state.innerVisibility,
      'hidden',
      'a descendant that re-declares visibility:visible must still be hidden'
    );
    assert.equal(state.blockVisibility, 'visible', 'our own block must stay visible');
    assert.equal(
      state.hitIsBlock,
      true,
      `the block must be what is painted there, got: ${state.hitText}`
    );
    assert.notEqual(
      state.blockBackground,
      'rgba(0, 0, 0, 0)',
      'the block must have an opaque background, or hidden content shows through'
    );
  });

  test('inline replace: teardown clears the marker and restores the content', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#override-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    await b.evaluate(`document.querySelector('.rs-inline .rs-close-btn').click()`);
    await b.waitUntil(`!document.querySelector('.rs-inline-host')`, 'the block to be removed');

    const after = await b.evaluate(`(() => {
      const target = document.querySelector('#override-target');
      const inner = document.querySelector('#override-inner');
      return {
        marked: target.classList.contains('rs-replacing'),
        innerVisibility: getComputedStyle(inner).visibility,
      };
    })()`);
    assert.equal(after.marked, false, 'the marker must be removed on teardown');
    assert.equal(after.innerVisibility, 'visible', 'the original content must come back');
  });

  test('inline prepend: inserts the UI as the first child, element untouched', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#content', mode: 'prepend' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const state = await b.evaluate(`(() => {
      const el = document.querySelector('#content');
      const host = document.querySelector('.rs-inline-host');
      return {
        firstChild: el.firstElementChild === host,
        inside: el.contains(host),
        visibility: getComputedStyle(el).visibility,
      };
    })()`);
    assert.equal(state.firstChild, true, 'prepend must insert as the first child');
    assert.equal(state.inside, true, 'prepend must insert inside the element');
    assert.notEqual(state.visibility, 'hidden', 'prepend must not hide the element');
  });

  test('inline append: inserts the UI as the last child, element untouched', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#content', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    const state = await b.evaluate(`(() => {
      const el = document.querySelector('#content');
      const host = document.querySelector('.rs-inline-host');
      return {
        lastChild: el.lastElementChild === host,
        inside: el.contains(host),
        visibility: getComputedStyle(el).visibility,
      };
    })()`);
    assert.equal(state.lastChild, true, 'append must insert as the last child');
    assert.equal(state.inside, true, 'append must insert inside the element');
    assert.notEqual(state.visibility, 'hidden', 'append must not hide the element');
  });

  test('inline block: the close button removes the binding and un-hides the element', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    await b.evaluate(`document.querySelector('.rs-inline .rs-close-btn').click()`);
    await b.waitUntil(`!document.querySelector('.rs-inline-host')`, 'the block to be removed');

    assert.deepEqual(
      await b.evaluate(`JSON.parse(window.__store.recentSubredditsSettings).targets`),
      [],
      'the binding must be removed from settings'
    );
    assert.equal(
      await b.evaluate(`getComputedStyle(document.querySelector('#pick-target')).visibility`),
      'visible',
      'the replaced element must be un-hidden when the binding is dropped'
    );
  });

  test('inline block: pinning works from the inline UI', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    await b.evaluate(`document.querySelector('.rs-inline .rs-pin-btn[data-name="javascript"]').click()`);
    await b.waitUntil(
      `document.querySelectorAll('.rs-inline .rs-pinned .rs-link').length === 2`,
      'the inline list to show the new pin'
    );

    const stored = JSON.parse(await b.evaluate(`window.__store.recentSubreddits`));
    assert.deepEqual(stored.pinned, ['javascript', 'linux'], 'the pin must be persisted');
  });

  test('inline block: settings open from its own gear and swap in place', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');

    await b.evaluate(`document.querySelector('.rs-inline .rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('.rs-inline').classList.contains('settings-open')`,
      'the inline panel to open'
    );

    const state = await b.evaluate(`(() => {
      const inst = document.querySelector('.rs-inline');
      return {
        title: inst.querySelector('.rs-header').textContent,
        panelShown: getComputedStyle(inst.querySelector('.rs-settings-panel')).display,
        listHidden: getComputedStyle(inst.querySelector('.rs-content')).display,
        // Opening the inline panel must NOT open the popup's.
        popupPanel: document.querySelector('.recent-subreddits-popup').classList.contains('settings-open'),
      };
    })()`);
    assert.equal(state.title, '⚙ Settings', 'the inline header must swap to the settings title');
    assert.equal(state.panelShown, 'block', 'the inline settings panel must be visible');
    assert.equal(state.listHidden, 'none', 'the inline list must be hidden while settings is open');
    assert.equal(state.popupPanel, false, 'the popup must not be affected');
  });

  test('changing an inline mode relocates the block', async () => {
    // Start as append, then switch to prepend through the settings UI — the real
    // write path, so this covers the mode-change reconcile too.
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#content', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'inline block to mount');
    assert.equal(
      await b.evaluate(`document.querySelector('#content').lastElementChild.classList.contains('rs-inline-host')`),
      true,
      'starts appended'
    );

    // Open the popup's settings and change the mode there. By hotkey: this test
    // supplies its own targets, so the seeded built-in hook is not present.
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.recent-subreddits-popup .rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('.recent-subreddits-popup').classList.contains('settings-open')`,
      'popup settings open'
    );

    await b.evaluate(`(() => {
      const sel = document.querySelector('.recent-subreddits-popup [data-role="mode"]');
      sel.value = 'prepend';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

    await b.waitUntil(
      `document.querySelector('#content').firstElementChild?.classList.contains('rs-inline-host')`,
      'the block to move to the front after the mode change'
    );
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-inline-host').length`),
      1,
      'relocating must not duplicate the block'
    );
    assert.equal(
      await b.evaluate(`getComputedStyle(document.querySelector('#content')).visibility`),
      'visible',
      'switching between two inline modes must not hide the element'
    );
  });

  test('a target whose element is absent on this page mounts nothing, silently', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#does-not-exist', mode: 'append' }] })
    );
    await b.waitUntil(`!!document.querySelector('.recent-subreddits-popup')`, 'popup mounted');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-inline-host').length`),
      0,
      'nothing should mount for an unmatched selector'
    );
    assert.deepEqual(await b.evaluate(`window.__errors`), [], 'a missing element must not throw');
  });

  test('an invalid stored selector does not break the other targets', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({
          targets: [
            { selector: '#content', mode: 'append' },
            { selector: '::not a selector::', mode: 'append' },
          ],
        })
    );
    await b.waitUntil(`!!document.querySelector('.rs-inline')`, 'the valid target to mount');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-inline-host').length`),
      1,
      'the valid target must still mount despite the invalid sibling'
    );
    assert.deepEqual(await b.evaluate(`window.__errors`), [], 'an invalid selector must not throw');
  });

  test('the built-in trigger ships as a settings target and reset restores it', async () => {
    // The built-in Reddit trigger used to be a hardcoded fallback. It is an
    // ordinary settings entry now, which is what makes it visible and removable —
    // and what makes "reset" able to put it back.
    await open();
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'popup open');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open'
    );

    // It is listed, with the full built-in selector.
    const listed = await b.evaluate(`(() => {
      const sel = document.querySelector('.rs-target-sel');
      return { text: sel.textContent, title: sel.title };
    })()`);
    assert.match(listed.title, /top-nav-logo/, 'the built-in selector must be the listed target');
    assert.match(listed.title, /navbar-menu-button/, 'and must cover the whole combined selector');

    // Delete it, then confirm the list says the popup is hotkey-only.
    await b.evaluate(`document.querySelector('[data-role="remove"]').click()`);
    await b.waitUntil(
      `JSON.parse(window.__store.recentSubredditsSettings).targets.length === 0`,
      'the built-in target to be removed'
    );
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-target').length`),
      0,
      'removing it must leave no rows'
    );
    assert.match(
      await b.evaluate(`document.querySelector('.rs-warn').textContent`),
      /Alt\+Shift\+R/,
      'with no hook, settings must point at the hotkey'
    );
    // Hover must genuinely stop opening the popup.
    await b.evaluate(`document.querySelector('[data-role="done"]').click()`);
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(`!${isVisible}`, 'popup closed');
    await b.evaluate(HOVER('#logo'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await b.evaluate(isVisible), false, 'with no hook, hovering must not open the popup');

    // Reset restores it — a restore, not a wipe.
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup reopened by hotkey');
    await b.evaluate(`document.querySelector('.rs-settings-btn').click()`);
    await b.waitUntil(
      `document.querySelector('${POPUP}').classList.contains('settings-open')`,
      'settings open again'
    );
    await b.evaluate(`document.querySelector('[data-role="reset"]').click()`);
    await b.waitUntil(
      `JSON.parse(window.__store.recentSubredditsSettings).targets.length === 1`,
      'reset to restore a target'
    );
    assert.equal(
      await b.evaluate(`document.querySelectorAll('.rs-target').length`),
      1,
      'reset must restore the built-in trigger row'
    );
    assert.equal(
      await b.evaluate(`!!document.querySelector('.rs-warn')`),
      false,
      'the hotkey-only warning must be gone once a hook is restored'
    );

    // And hover works again.
    await b.evaluate(`document.querySelector('[data-role="done"]').click()`);
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(`!${isVisible}`, 'popup closed');
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, 'hover to open the popup again after reset');
  });

  test('WARNS once when no trigger selector matches', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&noTriggers=1`);
    await b.waitUntil(`!!document.querySelector('${POPUP}')`, 'popup to mount');

    const warns = await b.waitUntil(
      `window.__warns.length > 0 ? window.__warns : null`,
      'a warning about the missing trigger'
    );
    assert.equal(warns.length, 1, `expected exactly one warning, got ${JSON.stringify(warns)}`);
    assert.match(warns[0], /none of the configured hooks matched/i);
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

  test('run() serialises a real function for evaluate', async () => {
    await open();
    // Use run() instead of a template literal — the function body is real code.
    const selector = '#logo';
    const width = await b.evaluate(run((sel) => {
      const el = document.querySelector(sel);
      return el ? el.getBoundingClientRect().width : null;
    }, selector));
    assert.ok(width > 0, 'the logo element must have a positive width');
  });
});
