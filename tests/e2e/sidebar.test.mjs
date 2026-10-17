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
function fixtureUrl(seed, iconDelay = 5, iconFail = null, settings = null) {
  const b64 = Buffer.from(JSON.stringify(seed), 'utf8').toString('base64');
  const fail = iconFail ? `&iconFail=${encodeURIComponent(iconFail)}` : '';
  const settingsQuery = settings ? `&settings=${settingsParam(settings)}` : '';
  return `${FIXTURE}?seed=${encodeURIComponent(b64)}&iconDelay=${iconDelay}${fail}${settingsQuery}`;
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
const HOVER = (sel) => run((sel) => {
  const el = document.querySelector(sel);
  if (!el) throw new Error('no element for ' + sel);
  const opts = { bubbles: true, cancelable: true, relatedTarget: document.body };
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
  return true;
}, sel);

const CLICK_BODY = run(() => document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const POPUP = `.recent-subreddits-popup`;
const isVisible = run((popupSel) => !!document.querySelector(popupSel)?.classList.contains('visible'), POPUP);

/**
 * Dispatch a keydown for a combo string like "Alt+Shift+r".
 *
 * Targets `document.activeElement` so it reaches whichever node has focus: the
 * userscript's global listener is on `document`, and the settings hotkey field
 * handles its own keydown, so a focused field is exercised the way a real key
 * press would be. Bubbles, so a document-level listener still sees it.
 */
const PRESS = (combo) => run((combo) => {
  const parts = combo.split('+');
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
}, combo);

/** Replace the host header with fresh nodes, simulating SPA navigation re-render. */
const RERENDER_HEADER = run(() => {
  const old = document.querySelector('#site-header');
  const fresh = document.createElement('header');
  fresh.id = 'site-header';
  fresh.innerHTML = '<a href="/" id="logo" data-testid="top-nav-logo"><span>R</span></a>'
                  + '<button id="menu-btn" aria-label="Open menu">menu</button>';
  old.replaceWith(fresh);
  return true;
});

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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    return b;
  }

  /**
   * Hover the built-in trigger and wait for the popup to show.
   *
   * The single place that knows how the popup opens: when the built-in trigger
   * became a settings entry, every inline copy of this preamble had to be found
   * and edited. `label` names the wait for a failing test.
   */
  async function openPopup(label = 'popup open') {
    await b.evaluate(HOVER('#logo'));
    await b.waitUntil(isVisible, label);
  }

  /**
   * Open the settings panel inside an already-open popup and wait for it.
   *
   * Split from openSettings() so a test that opens the popup another way — the
   * hotkey, a seeded target — can reuse the panel half without re-hovering.
   */
  async function openPanel(label = 'settings open') {
    await b.evaluate(run(() => document.querySelector('.rs-settings-btn').click()));
    await b.waitUntil(
      run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      label
    );
  }

  /**
   * Open the popup, then the settings panel inside it, and wait for the panel.
   * Callers that need the list view first get it from openPopup().
   */
  async function openSettings(label = 'settings open') {
    await openPopup();
    await openPanel(label);
  }

  test('mounts hidden, then shows on hover below the trigger', async () => {
    await open();
    assert.equal(await b.evaluate(isVisible), false, 'popup must start hidden');

    await openPopup('popup to become visible on hover');

    // Geometry, not just the class: popup sits just below the logo.
    const geo = await b.evaluate(run((popupSel) => {
      const t = document.querySelector('#logo').getBoundingClientRect();
      const p = document.querySelector(popupSel).getBoundingClientRect();
      return { triggerBottom: t.bottom, popupTop: p.top, popupLeft: p.left, winW: innerWidth };
    }, POPUP));
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

    await openPopup('popup on first hover');
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'popup to close');

    await b.evaluate(RERENDER_HEADER);

    // Prove the nodes really are new (a no-op re-render would pass vacuously).
    await openPopup('popup to show after the header was replaced');
  });

  test('REGRESSION: hover works when the host wipes the injected wrapper', async () => {
    await open();

    // Detach and re-check inside ONE evaluation: the MutationObserver re-mounts
    // on its own tick, so a separate evaluate would race it.
    const detached = await b.evaluate(run(() => {
      document.querySelector('.recent-subreddits-container').remove();
      return !document.querySelector('.recent-subreddits-container');
    }));
    assert.equal(detached, true, 'wrapper should be detached immediately after remove()');

    // Nudge the DOM so the observer runs, then expect re-mount.
    await b.evaluate(run(() => document.body.appendChild(document.createElement('span'))));
    await b.waitUntil(
      run(() => !!document.querySelector('.recent-subreddits-container')),
      'wrapper to be re-mounted by the observer'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.recent-subreddits-container').length)),
      1,
      're-mount must not duplicate the wrapper'
    );
    assert.equal(
      await b.evaluate(run(() => !!document.getElementById('rs-styles'))),
      true,
      'stylesheet must survive too'
    );

    await openPopup('popup to show after re-mount');
  });

  test('hover on a child of the trigger also opens it', async () => {
    await open();
    // #logo contains a <span>; closest() must walk up to the anchor.
    await b.evaluate(HOVER('#logo span'));
    await b.waitUntil(isVisible, 'popup to show when a trigger child is hovered');
  });

  test('remove: the trash drops a subreddit from history and persists it', async () => {
    await open();
    await openPopup();

    // Every recent row offers a trash; the Pinned section does not (it has its
    // own unpin control).
    const controls = await b.evaluate(run(() => ({
      recentRows: document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-item').length,
      trashes: document.querySelectorAll('.rs-remove-btn').length,
      trashesInPinned: document.querySelectorAll('.rs-pinned-section .rs-remove-btn').length,
    })));
    assert.equal(controls.trashes, controls.recentRows, 'every recent row needs a trash');
    assert.equal(controls.trashesInPinned, 0, 'the pinned section must not get a trash');

    await b.evaluate(run(() => document.querySelector('.rs-remove-btn[data-name="webdev"]').click()));

    await b.waitUntil(
      run(() => !Array.from(document.querySelectorAll('.rs-link')).some(a => a.textContent === 'r/webdev')),
      'r/webdev to disappear from the list'
    );
    // No confirmation: one click, and it is gone.
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after removing');

    // Persisted, not just rendered — a reload must not bring it back.
    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits)));
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
    await openPopup();

    const state = await b.evaluate(run(() => ({
      linuxTrash: !!document.querySelector('.rs-remove-btn[data-name="linux"]'),
      linuxInRecent: Array.from(document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-link'))
        .some(a => a.textContent === 'r/linux'),
      linuxPinned: Array.from(document.querySelectorAll('.rs-pinned .rs-link'))
        .some(a => a.textContent === 'r/linux'),
    })));
    assert.equal(state.linuxInRecent, false, 'a pinned subreddit must not be listed under Recent');
    assert.equal(state.linuxPinned, true, 'r/linux should be pinned in this fixture');
    assert.equal(state.linuxTrash, false, 'a pinned subreddit must not offer a trash');
  });

  test('remove: emptying the history shows the empty state', async () => {
    // The fixture pins r/linux, so clearing Recent must leave only the Pinned
    // section — no "no subreddits visited yet" line, because the list is not empty.
    await open();
    await openPopup();

    for (const name of ['javascript', 'webdev', 'rust']) {
      await b.evaluate(run((name) => {
        document.querySelector(`.rs-remove-btn[data-name="${name}"]`).click();
      }, name));
      await b.waitUntil(
        run((nameArg) => !document.querySelector(`.rs-remove-btn[data-name="${nameArg}"]`), name),
        `r/${name} to be removed`
      );
    }

    const state = await b.evaluate(run(() => ({
      recentSection: !!document.querySelector('.rs-section:not(.rs-pinned-section)'),
      pinned: Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent),
      empty: !!document.querySelector('.rs-empty'),
      stored: JSON.parse(window.__store.recentSubreddits).recent.map(r => r.name),
    })));
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
    await openPopup();

    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-blocked-list').length)),
      0,
      'the blacklist UI only exists inside the settings panel'
    );

    await b.evaluate(run(() => document.querySelector('.rs-remove-btn[data-name="webdev"]').click()));
    await b.waitUntil(
      run(() => !document.querySelector('.rs-remove-btn[data-name="webdev"]')),
      'r/webdev to be removed'
    );

    const blocked = JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).blocked;
    assert.deepEqual(blocked, ['webdev'], 'the removal must blacklist the subreddit');
  });

  test('blacklist: settings shows the blocklist as a textarea, one name per line', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev,rust`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    await openSettings();

    // The blocklist lives in a collapsed accordion section — open it first.
    await b.evaluate(run(() => {
      const headers = document.querySelectorAll('.rs-acc-header');
      headers[2].click(); // "Blocked subreddits"
      return true;
    }));

    const state = await b.evaluate(run(() => {
      const ta = document.querySelector('.rs-blocked-input');
      const cs = getComputedStyle(ta);
      return {
        tag: ta.tagName,
        value: ta.value,
        lines: ta.value.split('\n'),
        // Must be a real multi-line field, not a text input.
        rows: ta.rows,
        height: Math.round(ta.getBoundingClientRect().height),
        resizable: cs.resize,
        // The old per-row list must be gone.
        oldList: !!document.querySelector('.rs-blocked-list'),
      };
    }));

    assert.equal(state.tag, 'TEXTAREA', 'the blocklist must be a textarea');
    assert.deepEqual(state.lines, ['webdev', 'rust'], 'one subreddit per line, in order');
    assert.equal(state.oldList, false, 'the old per-row list must be gone');
    assert.ok(state.height > 40, `a textarea must be multi-line, got ${state.height}px`);
    assert.equal(state.resizable, 'vertical', 'it should be user-resizable');
  });

  test('blacklist: editing the textarea saves the blocklist and re-enables tracking', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev,rust`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    await openSettings();

    // Delete r/rust's line and add two more — the real edit path: type, then
    // blur (which is what fires `change`).
    await b.evaluate(run(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.value = 'webdev\n  Linux  \nr/webdev\n';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    const stored = JSON.parse(
      await b.evaluate(run(() => window.__store.recentSubredditsSettings))
    ).blocked;
    // Normalized: trimmed, lowercased, r/ prefix stripped, duplicates dropped,
    // blank lines ignored.
    assert.deepEqual(stored, ['webdev', 'linux'], `blocklist must be normalized, got ${JSON.stringify(stored)}`);

    // The field itself keeps what was typed (not re-rendered underneath the user).
    assert.equal(
      await b.evaluate(run(() => document.querySelector('.rs-blocked-input').value)),
      'webdev\n  Linux  \nr/webdev\n',
      'the textarea must not be rewritten while the user is editing'
    );
  });

  test('blacklist: clearing the textarea clears the blocklist', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    await openSettings();

    await b.evaluate(run(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.value = '';
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    assert.deepEqual(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).blocked,
      [],
      'an empty textarea must clear the blocklist'
    );
  });

  test('blacklist: typing in the textarea does not fire the global hotkey', async () => {
    // The panel's field must swallow its keys: the hotkey handler is on
    // `document`, and a bare letter typed here must not be read as a shortcut.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&blocked=webdev`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    await openSettings();

    // The default hotkey is Alt+Shift+R; press it inside the field.
    await b.evaluate(run(() => {
      const ta = document.querySelector('.rs-blocked-input');
      ta.focus();
      ta.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'r', altKey: true, shiftKey: true, bubbles: true, cancelable: true,
      }));
      return true;
    }));

    assert.equal(await b.evaluate(isVisible), true, 'the popup must not toggle from a key in the field');
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP)),
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-remove-btn[data-name="rust"]').click()));
    await b.waitUntil(
      run(() => !document.querySelector('.rs-inline .rs-remove-btn[data-name="rust"]')),
      'r/rust to disappear from the inline block'
    );

    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits)));
    assert.ok(
      !stored.recent.some((r) => r.name === 'rust'),
      `the inline removal must persist, got ${JSON.stringify(stored.recent.map((r) => r.name))}`
    );
  });

  test('pin/unpin keeps the popup open and persists the change', async () => {
    await open();
    await openPopup();

    await b.evaluate(run(() => document.querySelector('.rs-pin-btn[data-name="javascript"]').click()));
    // Give the click handler a beat, then assert it stayed open.
    await b.waitUntil(
      run(() => document.querySelectorAll('.rs-pinned .rs-link').length === 2),
      'r/javascript to appear under Pinned'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after pinning');
    assert.deepEqual(
      await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent))),
      ['r/javascript', 'r/linux']
    );

    await b.evaluate(run(() => document.querySelector('.rs-unpin-btn[data-name="linux"]').click()));
    await b.waitUntil(
      run(() => document.querySelectorAll('.rs-pinned .rs-link').length === 1),
      'r/linux to be unpinned'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup must stay open after unpinning');
    assert.deepEqual(
      await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent))),
      ['r/javascript']
    );

    // Unpinned r/linux returns to the Recent list, and the stale entry is gone
    // from Pinned — assert absence, not just presence.
    const recentNames = await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-section:not(.rs-pinned-section) .rs-link')).map(a => a.textContent)));
    assert.ok(recentNames.includes('r/linux'), `r/linux should return to Recent, got ${recentNames}`);

    // The change must be persisted, not just rendered.
    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits)));
    assert.deepEqual(stored.pinned, ['javascript'], 'pin state must be written to GM storage');
  });

  test('reorder: up/down buttons change the pinned order', async () => {
    // Seed with three pinned subreddits so both directions are testable.
    const seed = { recent: [], pinned: ['alpha', 'beta', 'gamma'] };
    await b.goto(fixtureUrl(seed));
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    // Move alpha down: alpha beta gamma -> beta alpha gamma
    await b.evaluate(run(() => document.querySelector('.rs-reorder-down[data-name="alpha"]').click()));
    await b.waitUntil(
      run(() => {
        const names = Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent);
        return names.join(',') === 'r/beta,r/alpha,r/gamma';
      }),
      'alpha to move down'
    );
    assert.deepEqual(
      await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent))),
      ['r/beta', 'r/alpha', 'r/gamma']
    );

    // Move gamma up: beta alpha gamma -> beta gamma alpha
    await b.evaluate(run(() => document.querySelector('.rs-reorder-up[data-name="gamma"]').click()));
    await b.waitUntil(
      run(() => {
        const names = Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent);
        return names.join(',') === 'r/beta,r/gamma,r/alpha';
      }),
      'gamma to move up'
    );

    // Persisted, not just rendered.
    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits)));
    assert.deepEqual(stored.pinned, ['beta', 'gamma', 'alpha'], 'reorder must be written to GM storage');
  });

  test('reorder: first item has up disabled, last item has down disabled', async () => {
    const seed = { recent: [], pinned: ['alpha', 'beta', 'gamma'] };
    await b.goto(fixtureUrl(seed));
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    const disabled = await b.evaluate(run(() => ({
      firstUp: document.querySelector('.rs-reorder-up[data-name="alpha"]').disabled,
      lastDown: document.querySelector('.rs-reorder-down[data-name="gamma"]').disabled,
      middleUp: document.querySelector('.rs-reorder-up[data-name="beta"]').disabled,
      middleDown: document.querySelector('.rs-reorder-down[data-name="beta"]').disabled,
    })));
    assert.equal(disabled.firstUp, true, 'first item must have up disabled');
    assert.equal(disabled.lastDown, true, 'last item must have down disabled');
    assert.equal(disabled.middleUp, false, 'middle item must have up enabled');
    assert.equal(disabled.middleDown, false, 'middle item must have down enabled');
  });

  test('reorder: clicking a disabled button does not change the order', async () => {
    const seed = { recent: [], pinned: ['alpha', 'beta'] };
    await b.goto(fixtureUrl(seed));
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    // Click the disabled up on the first item — should be a no-op.
    await b.evaluate(run(() => document.querySelector('.rs-reorder-up[data-name="alpha"]').click()));
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(
      await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-pinned .rs-link')).map(a => a.textContent))),
      ['r/alpha', 'r/beta'],
      'order must not change when clicking a disabled button'
    );
  });

  test('reorder: works from an inline block too', async () => {
    const settings = {
      hotkey: 'Alt+Shift+R',
      targets: [{ selector: '#pick-target', mode: 'replace', events: 'both' }],
      blocked: [],
    };
    const seed = { recent: [], pinned: ['alpha', 'beta', 'gamma'] };
    await b.goto(fixtureUrl(seed, 5, null, settings));
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline .rs-pinned')), 'inline block to mount');

    // Move alpha down in the inline block.
    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-reorder-down[data-name="alpha"]').click()));
    await b.waitUntil(
      run(() => {
        const names = Array.from(document.querySelectorAll('.rs-inline .rs-pinned .rs-link')).map(a => a.textContent);
        return names.join(',') === 'r/beta,r/alpha,r/gamma';
      }),
      'alpha to move down in inline block'
    );
  });

  test('fetches a subreddit icon and patches the src in place', async () => {
    // Slow the stubbed fetch so the placeholder state is actually observable —
    // with a fast fetch the assertion would race the replacement.
    await open(DEFAULT_SEED, 400);

    assert.match(
      await b.evaluate(run(() => document.querySelector('.rs-icon').getAttribute('src'))),
      /^data:image\/svg\+xml/,
      'icon should start as the inline placeholder'
    );

    await b.waitUntil(
      run(() => Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))),
      'all icons to be replaced by fetched URLs',
      15000
    );

    const pairs = await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
      name: decodeURIComponent(i.dataset.name),
      src: i.getAttribute('src'),
    }))));
    for (const { name, src } of pairs) {
      assert.equal(src, `https://icons.test/${name}.png`, `icon for ${name} mapped to the wrong src`);
    }
    assert.equal(
      await b.evaluate(run(() => window.__xhrCalls.length)),
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
      run(() => Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))),
      'every icon to recover after a transient 403',
      25000
    );

    const state = await b.evaluate(run(() => ({
      attempts: window.__iconAttempts,
      srcs: Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
        name: decodeURIComponent(i.dataset.name),
        src: i.getAttribute('src'),
      })),
    })));

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
      run(() => Array.from(document.querySelectorAll('.rs-icon')).every(i => i.getAttribute('src').startsWith('https://icons.test/'))),
      'all icons to load',
      20000
    );

    const timing = await b.evaluate(run(() => {
      const t = window.__xhrTimes || [];
      const gaps = [];
      for (let i = 1; i < t.length; i++) gaps.push(Math.round(t[i] - t[i - 1]));
      return { count: t.length, gaps, minGap: gaps.length ? Math.min(...gaps) : null };
    }));

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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    const harvested = await b.evaluate(run(() => {
      const img = Array.from(document.querySelectorAll('.rs-icon'))
        .find(i => decodeURIComponent(i.dataset.name) === 'javascript');
      return { src: img ? img.getAttribute('src') : null, harvestUrl: window.__harvestIconUrl };
    }));
    assert.equal(
      harvested.src,
      harvested.harvestUrl,
      'the current subreddit icon must be adopted from the page'
    );

    // And it must NOT have been fetched: that is the whole point.
    const fetched = await b.evaluate(run(() => window.__xhrCalls.filter(u => /\/r\/javascript\/about\.json/.test(u)).length));
    assert.equal(fetched, 0, 'a harvested icon must not also trigger an about.json fetch');

    // Other rows still need the fallback, so they do fetch.
    assert.ok(
      (await b.evaluate(run(() => window.__xhrCalls.length))) > 0,
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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    const state = await b.evaluate(run(() => {
      const rows = Array.from(document.querySelectorAll('.rs-icon')).map(i => ({
        name: decodeURIComponent(i.dataset.name),
        src: i.getAttribute('src'),
      }));
      return { rows, harvestUrl: window.__harvestIconUrl };
    }));

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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    const adopted = await b.evaluate(run(() => {
      // Poison the anchor with a non-reddit URL, then force a harvest by opening
      // the popup (which harvests before showing).
      const el = document.querySelector('#subreddit-icon-img img');
      el.setAttribute('src', 'https://evil.example.com/icon.png');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', altKey: true, shiftKey: true, bubbles: true, cancelable: true }));
      const img = Array.from(document.querySelectorAll('.rs-icon'))
        .find(i => decodeURIComponent(i.dataset.name) === 'javascript');
      return img ? img.getAttribute('src') : null;
    }));
    assert.ok(
      !String(adopted).includes('evil.example.com'),
      `a non-redditmedia URL must never be adopted, got ${adopted}`
    );
  });

  test('close paths: outside click, close button, Escape', async () => {
    await open();

    for (const [label, close] of [
      ['outside click', CLICK_BODY],
      ['close button', run(() => document.querySelector('.rs-close-btn').click())],
      ['Escape', run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))],
    ]) {
      await openPopup(`popup open before testing ${label}`);
      await b.evaluate(close);
      await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), `popup to close via ${label}`);
    }
  });

  test('the logo link still navigates (preventDefault only while opening)', async () => {
    await open();

    // First click opens the popup and must swallow the navigation.
    const first = await b.evaluate(run(() => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.querySelector('#logo').dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, open: !!document.querySelector('.recent-subreddits-popup')?.classList.contains('visible') };
    }));
    assert.deepEqual(first, { prevented: true, open: true }, 'opening click should preventDefault');

    // Second click closes it and must let the link through.
    const second = await b.evaluate(run(() => {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      document.querySelector('#logo').dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, open: !!document.querySelector('.recent-subreddits-popup')?.classList.contains('visible') };
    }));
    assert.deepEqual(second, { prevented: false, open: false }, 'closing click must not preventDefault');
  });

  // ---- Viewport fitting: the popup must never be cut off ----

  /** Park the logo at a fixed spot, like a real page header would sit. */
  const parkLogo = (top, left = 300) => run((a) => {
    const [t, l] = a;
    const logo = document.querySelector('#logo');
    logo.style.cssText = `position:fixed;top:${t}px;left:${l}px;display:block;width:40px;height:40px;`;
    return true;
  }, [top, left]);

  /** Force a viewport size, so the fit can be asserted at more than one height. */
  async function viewport(width, height) {
    await b.session('Emulation.setDeviceMetricsOverride', {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
  }

  /** Where the popup renders, and whether anything of it is off-screen. */
  const FIT = run((popupSel) => {
    const p = document.querySelector(popupSel);
    const r = p.getBoundingClientRect();
    const done = p.querySelector('[data-role="done"]');
    const hit = done ? document.elementFromPoint(
      Math.round(done.getBoundingClientRect().left + done.getBoundingClientRect().width / 2),
      Math.round(done.getBoundingClientRect().top + done.getBoundingClientRect().height / 2)
    ) : null;
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      height: Math.round(r.height),
      winH: window.innerHeight,
      overflowsBottom: Math.round(r.bottom - window.innerHeight),
      overflowsTop: Math.round(-r.top),
      // Rendered total width, to pin box-sizing against POPUP_WIDTH.
      width: Math.round(r.width),
      // Is the panel's exit reachable without scrolling to it?
      doneOnScreen: done ? (() => {
        const d = done.getBoundingClientRect();
        return d.bottom <= window.innerHeight && d.top >= 0;
      })() : null,
      // ...and is it actually what is painted there (not covered by the fields
      // scrolling behind it)?
      doneHit: hit ? (hit === done || done.contains(hit) ? 'done' : hit.tagName.toLowerCase()) : null,
    };
  }, POPUP);

  test('FIT: opening settings re-places the popup, so it is not cut off at the bottom', async () => {
    // The bug: the popup was placed once, from the list's height. Opening
    // settings grew it from ~116px to ~530px while it kept the old position, so
    // it ran off the bottom of the viewport. Measured before the fix: at
    // 1280x600 with a short list and the trigger parked low, the popup ended
    // 92px past the viewport bottom and Done sat at bottom 800 — unreachable.
    await viewport(1280, 600);
    await b.goto(`${fixtureUrl({ recent: [{ name: 'a', visitedAt: Date.now() }], pinned: [] })}&iconDelay=999999`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    // Park the trigger low, which is what makes the list-height placement wrong.
    await b.evaluate(parkLogo(540));
    await openPopup('popup open with the trigger low');

    const list = await b.evaluate(FIT);
    assert.ok(list.overflowsBottom <= 0, `the list must fit, got ${JSON.stringify(list)}`);

    await openPanel('settings panel open');

    const settings = await b.evaluate(FIT);
    assert.ok(
      settings.overflowsBottom <= 0,
      `opening settings must not push the popup off the bottom, got ${JSON.stringify(settings)}`
    );
    assert.ok(settings.overflowsTop <= 0, `nor off the top, got ${JSON.stringify(settings)}`);
    assert.ok(
      settings.height > list.height,
      `the panel is taller than the list, so this must be the grown case: ${JSON.stringify({ list, settings })}`
    );
  });

  test('FIT: the popup never overflows the viewport, at any trigger position or height', async () => {
    // Sweep the combinations that broke it: trigger high / low / at the right
    // edge, and a viewport too short to hold the panel.
    const seed = { recent: [{ name: 'a', visitedAt: Date.now() }], pinned: [] };
    const cases = [
      { w: 1280, h: 800, top: 8, left: 300, label: 'tall viewport, trigger high' },
      { w: 1280, h: 600, top: 8, left: 300, label: 'trigger high' },
      { w: 1280, h: 600, top: 540, left: 300, label: 'trigger low' },
      { w: 1280, h: 500, top: 8, left: 300, label: 'short viewport' },
      { w: 1280, h: 600, top: 8, left: 1250, label: 'trigger at the right edge' },
      { w: 1280, h: 600, top: 540, left: 1250, label: 'trigger low and right' },
    ];

    for (const c of cases) {
      await viewport(c.w, c.h);
      await b.goto(`${fixtureUrl(seed)}&iconDelay=999999`);
      await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
      await b.evaluate(parkLogo(c.top, c.left));
      await openPopup(`popup open (${c.label})`);

      for (const [view, step] of [['list', null], ['settings', 'openPanel']]) {
        if (step === 'openPanel') await openPanel(`settings open (${c.label})`);
        const m = await b.evaluate(FIT);
        assert.ok(
          m.overflowsBottom <= 0,
          `${c.label} / ${view}: popup runs ${m.overflowsBottom}px past the bottom, got ${JSON.stringify(m)}`
        );
        assert.ok(
          m.overflowsTop <= 0,
          `${c.label} / ${view}: popup runs ${m.overflowsTop}px past the top, got ${JSON.stringify(m)}`
        );
        // The width clamp uses POPUP_WIDTH, so the rendered box has to match it.
        assert.ok(
          m.width <= 280,
          `${c.label} / ${view}: rendered ${m.width}px wide, wider than the 280px the clamp assumes`
        );
      }

      // Close between cases so the next open is a fresh placement.
      await b.evaluate(CLICK_BODY);
      await b.waitUntil(run((popupSel) => !document.querySelector(popupSel).classList.contains('visible'), POPUP), 'popup closed');
    }
  });

  test('FIT: the settings panel is scrollable and its Done button stays reachable', async () => {
    // A viewport too short for the panel: the popup caps and scrolls, and
    // Done is the way OUT of the panel, so it must not be the thing that scrolls
    // out of reach. It is sticky for that reason.
    await viewport(1280, 350);
    await b.goto(`${fixtureUrl({ recent: [{ name: 'a', visitedAt: Date.now() }], pinned: [] })}&iconDelay=999999`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();
    await openPanel('settings panel open');

    // Open all accordion sections so the panel is tall enough to overflow.
    await b.evaluate(run(() => {
      document.querySelectorAll('.rs-acc-header').forEach((h) => {
        const section = h.closest('.rs-acc-section');
        if (!section.classList.contains('rs-acc-open')) h.click();
      });
      return true;
    }));

    const scrollable = await b.evaluate(run((popupSel) => {
      const p = document.querySelector(popupSel);
      return { canScroll: p.scrollHeight > p.clientHeight, clientH: p.clientHeight, scrollH: p.scrollHeight };
    }, POPUP));
    assert.equal(
      scrollable.canScroll,
      true,
      `the panel must scroll rather than overflow, got ${JSON.stringify(scrollable)}`
    );

    // Reachable AND topmost — a sticky bar with no background would let the
    // fields show through it, which reads as a cut-off button.
    const before = await b.evaluate(FIT);
    assert.equal(before.doneOnScreen, true, `Done must be on screen, got ${JSON.stringify(before)}`);
    assert.equal(before.doneHit, 'done', `Done must be what is painted there, got ${JSON.stringify(before)}`);

    // Still reachable after scrolling to the end of the panel.
    await b.evaluate(run((popupSel) => { document.querySelector(popupSel).scrollTop = 99999; return true; }, POPUP));
    const after = await b.evaluate(FIT);
    assert.equal(after.doneOnScreen, true, `Done must stay on screen after scrolling, got ${JSON.stringify(after)}`);
    assert.equal(after.doneHit, 'done', `and stay clickable, got ${JSON.stringify(after)}`);

    // And it really does exit the panel.
    await b.evaluate(run(() => document.querySelector('[data-role="done"]').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      'Done to close the settings panel'
    );
  });

  test('flips above the trigger when there is no room below', async () => {
    await open();

    await b.evaluate(run(() => document.querySelector('#logo').style.cssText = 'position:fixed;bottom:2px;left:300px;'));
    await openPopup();

    const geo = await b.evaluate(run((popupSel) => {
      const t = document.querySelector('#logo').getBoundingClientRect();
      const p = document.querySelector(popupSel).getBoundingClientRect();
      return { triggerTop: Math.round(t.top), popupBottom: Math.round(p.bottom), popupTop: Math.round(p.top), winH: innerHeight };
    }, POPUP));
    assert.ok(
      geo.popupBottom <= geo.triggerTop + 1,
      `popup should flip above the trigger, got ${JSON.stringify(geo)}`
    );
    assert.ok(geo.popupTop >= 0, `flipped popup must stay on screen, got ${JSON.stringify(geo)}`);
  });

  test('no uncaught errors during a full interaction run', async () => {
    await open();
    await openPopup();
    await b.evaluate(run(() => document.querySelector('.rs-pin-btn').click()));
    await b.evaluate(RERENDER_HEADER);
    await b.evaluate(HOVER('#logo'));
    await b.evaluate(CLICK_BODY);

    const errors = await b.evaluate(run(() => window.__errors));
    assert.deepEqual(errors, [], `page reported errors: ${JSON.stringify(errors)}`);
  });

  test('hotkey opens the popup with no trigger present', async () => {
    // This is the whole point of the hotkey: it must work when every trigger
    // selector has stopped matching.
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&noTriggers=1`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    assert.equal(await b.evaluate(isVisible), false, 'popup starts hidden');

    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup to open via hotkey');

    // Centred, since there is no trigger to anchor to.
    const geo = await b.evaluate(run((popupSel) => {
      const p = document.querySelector(popupSel).getBoundingClientRect();
      return { left: Math.round(p.left), top: Math.round(p.top), winW: innerWidth, winH: innerHeight };
    }, POPUP));
    assert.ok(Math.abs(geo.left - (geo.winW - 280) / 2) < 2, `hotkey popup should be centred horizontally: ${JSON.stringify(geo)}`);
    assert.ok(geo.top > 0, `centred popup must be on screen: ${JSON.stringify(geo)}`);
  });

  test('hotkey toggles the popup closed again', async () => {
    await open();
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup open via hotkey');
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'popup closed via hotkey');
  });

  test('the default hotkey does not fire on a different combination', async () => {
    await open();
    await b.evaluate(PRESS('Alt+r'));       // missing Shift
    await b.evaluate(PRESS('Ctrl+Shift+r')); // wrong modifier
    assert.equal(await b.evaluate(isVisible), false, 'only the configured combo may open the popup');
  });

  test('settings modal opens, captures a new hotkey, and it takes effect', async () => {
    await open();
    await openPopup();

    // Open settings via the gear.
    await openPanel('settings panel to open');
    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('.rs-settings-panel')).display)),
      'block',
      'settings panel should be visible'
    );

    // Focus the field and press a new combination.
    await b.evaluate(run(() => document.querySelector('.rs-hotkey-input').focus()));
    await b.evaluate(PRESS('Ctrl+Shift+k'));

    assert.equal(
      await b.evaluate(run(() => document.querySelector('.rs-hotkey-input').value)),
      'Ctrl+Shift+K',
      'field should show the captured combination'
    );

    // Persisted, not just displayed.
    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings)));
    assert.equal(stored.hotkey, 'Ctrl+Shift+K', 'new hotkey must be written to storage');

    // The old combo no longer works, the new one does.
    await b.evaluate(run(() => document.querySelector('[data-role="done"]').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      'settings panel to close'
    );

    await b.evaluate(CLICK_BODY); // close popup
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'popup closed');

    await b.evaluate(PRESS('Alt+Shift+r'));
    assert.equal(await b.evaluate(isVisible), false, 'the replaced hotkey must stop working');

    await b.evaluate(PRESS('Ctrl+Shift+k'));
    await b.waitUntil(isVisible, 'popup to open via the newly configured hotkey');
  });

  test('settings rejects a combination without a modifier', async () => {
    await open();
    await openSettings('settings panel open');

    await b.evaluate(run(() => document.querySelector('.rs-hotkey-input').focus()));
    await b.evaluate(PRESS('k')); // bare letter

    const status = await b.evaluate(run(() => document.querySelector('.rs-status').textContent));
    assert.match(status, /modifier/i, `expected a modifier warning, got: ${status}`);
    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).hotkey,
      'Alt+Shift+R',
      'an invalid combination must not replace the hotkey'
    );
  });

  test('settings modal survives a pin change underneath it', async () => {
    // The popup node is persistent, so a content re-render must not close the modal.
    await open();
    await openSettings('settings panel open');

    await b.evaluate(run(() => document.querySelector('.rs-pin-btn[data-name="javascript"]').click()));
    await b.waitUntil(
      run(() => document.querySelectorAll('.rs-pinned .rs-link').length === 2),
      'pin to take effect'
    );
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP)),
      true,
      'settings must stay open across a content re-render'
    );
  });

  test('settings modal resets the hotkey to the default', async () => {
    await open();
    await openSettings('settings panel open');

    await b.evaluate(run(() => document.querySelector('.rs-hotkey-input').focus()));
    await b.evaluate(PRESS('Ctrl+Shift+k'));
    await b.evaluate(run(() => document.querySelector('[data-role="reset"]').click()));

    assert.equal(
      await b.evaluate(run(() => document.querySelector('.rs-hotkey-input').value)),
      'Alt+Shift+R',
      'reset should restore the default in the field'
    );
    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings)));
    assert.equal(stored.hotkey, 'Alt+Shift+R', 'reset should persist the default');
  });

  test('header shows the back button and "Settings" title, gear hidden, and back returns', async () => {
    await open();
    await openPopup();

    // List view: main icon+title, no back button, gear present.
    const list = await b.evaluate(run(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: q('.rs-header').textContent,
        back: getComputedStyle(q('.rs-back-btn')).display,
        gear: getComputedStyle(q('.rs-settings-btn')).display,
      };
    }));
    assert.equal(list.title, '📋 Recent Subreddits', 'list view should show the main icon+title');
    assert.equal(list.back, 'none', 'back button must be hidden in the list view');
    assert.notEqual(list.gear, 'none', 'gear must be visible in the list view');

    await openPanel('settings panel open');

    // Settings view: title swapped, back visible, gear hidden (redundant).
    const settings = await b.evaluate(run(() => {
      const q = (s) => document.querySelector(s);
      return {
        title: q('.rs-header').textContent,
        back: getComputedStyle(q('.rs-back-btn')).display,
        gear: getComputedStyle(q('.rs-settings-btn')).display,
      };
    }));
    assert.equal(settings.title, '⚙ Settings', 'settings view should show its own icon+title');
    assert.notEqual(settings.back, 'none', 'back button must be visible in settings');
    assert.equal(settings.gear, 'none', 'gear is redundant next to the Settings title and must be hidden');

    // The back button is the way out, and it restores the list view.
    await b.evaluate(run(() => document.querySelector('.rs-back-btn').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      'back button to close the settings panel'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelector('.rs-header').textContent)),
      '📋 Recent Subreddits',
      'back must restore the main title'
    );
    assert.equal(await b.evaluate(isVisible), true, 'back must not close the popup itself');
  });

  // ---- Hide row controls (opt-in) ----

  /**
   * Move the real pointer. The only thing that can drive CSS `:hover` — a
   * synthetic MouseEvent fires handlers on the node regardless of where the
   * cursor is, so it would pass while the control is unreachable.
   */
  async function movePointer(x, y) {
    await b.session('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
  }

  /** Centre of the first element matching `sel`, in viewport coordinates. */
  async function centreOf(sel) {
    return b.evaluate(run((s) => {
      const el = document.querySelector(s);
      if (!el) throw new Error('no element for ' + s);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
    }, sel));
  }

  /** Computed opacity of the row controls and the header close button. */
  const OPACITIES = run((popupSel) => {
    const q = (s) => document.querySelector(popupSel + ' ' + s);
    const op = (el) => (el ? getComputedStyle(el).opacity : null);
    return {
      hasClass: document.querySelector(popupSel).classList.contains('rs-hide-controls'),
      pin: op(q('.rs-pin-btn')),
      trash: op(q('.rs-remove-btn')),
      close: op(q('.rs-close-btn')),
    };
  }, POPUP);

  /**
   * Wait for one control's opacity to settle at `want`.
   *
   * Polling, not a bare read: the controls transition their opacity over 0.15s,
   * so a single read right after the pointer moves samples a value part-way
   * through and reads as "the hover did nothing".
   */
  function opacityIs(which, want) {
    return run((args) => {
      const [popupSel, w, expected] = args;
      const el = document.querySelector(popupSel + ' ' + w);
      return el ? getComputedStyle(el).opacity === expected : false;
    }, [POPUP, which, want]);
  }

  test('hide row controls: OFF by default, so every control is visible without hovering', async () => {
    await open();
    await openPopup();

    const before = await b.evaluate(OPACITIES);
    assert.equal(before.hasClass, false, 'the opt-in must not be on by default');
    for (const [name, value] of Object.entries(before)) {
      if (name === 'hasClass') continue;
      assert.notEqual(value, '0', `${name} must be visible without hovering when the option is off`);
    }
  });

  test('hide row controls: ON hides the pin, trash and close until their row is hovered', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&settings=${settingsParam({ hideRowControls: true })}`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    // Hidden while the pointer is away.
    assert.equal((await b.evaluate(OPACITIES)).pin, '0', 'the pin must be hidden before hovering');
    assert.equal((await b.evaluate(OPACITIES)).trash, '0', 'the trash must be hidden before hovering');
    assert.equal((await b.evaluate(OPACITIES)).close, '0', 'the close button must be hidden before hovering');

    // Hover the row itself — not the button — which is what reveals it.
    const row = await centreOf('.rs-section:not(.rs-pinned-section) .rs-item');
    assert.ok(row.w > 0 && row.h > 0, `the row must have a real box, got ${JSON.stringify(row)}`);
    await movePointer(row.x, row.y);

    await b.waitUntil(opacityIs('.rs-pin-btn', '1'), 'hovering the row to reveal the pin');
    await b.waitUntil(opacityIs('.rs-remove-btn', '1'), 'hovering the row to reveal the trash');
    assert.equal(
      (await b.evaluate(OPACITIES)).close,
      '0',
      'the close button belongs to the header, not the row'
    );

    // Revealed means reachable: the pointer is genuinely over the control.
    const pin = await centreOf('.rs-pin-btn');
    const hit = await b.evaluate(run((p) => {
      const el = document.elementFromPoint(p.x, p.y);
      return el ? (el.closest('.rs-pin-btn') ? 'pin' : el.tagName.toLowerCase()) : null;
    }, pin));
    assert.equal(hit, 'pin', 'the revealed pin must be what the pointer hits');

    // And the header's own hover reveals the close button.
    const header = await centreOf('.rs-header-row');
    await movePointer(header.x, header.y);
    await b.waitUntil(opacityIs('.rs-close-btn', '1'), 'hovering the header row to reveal the close button');
  });

  test('hide row controls: the settings checkbox persists the choice', async () => {
    await open();
    await openSettings('settings panel open');

    // The control starts unchecked, matching the default.
    assert.equal(
      await b.evaluate(run(() => document.querySelector('[data-role="hide-controls"]').checked)),
      false,
      'the checkbox must reflect the default'
    );

    await b.evaluate(run(() => {
      const cb = document.querySelector('[data-role="hide-controls"]');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).hideRowControls,
      true,
      'the choice must be persisted'
    );
    // Applied to the live instance, not only on the next mount.
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('rs-hide-controls'), POPUP)),
      true,
      'the instance must pick the class up immediately'
    );

    // Reset puts it back off — it is a restore, not a wipe.
    await b.evaluate(run(() => document.querySelector('[data-role="reset"]').click()));
    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).hideRowControls,
      false,
      'reset must clear it'
    );
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('rs-hide-controls'), POPUP)),
      false,
      'and the class must come back off'
    );
  });

  test('hide row controls: an inline block honours it too', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ hideRowControls: true, targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    assert.equal(
      await b.evaluate(run(() => document.querySelector('.rs-inline').classList.contains('rs-hide-controls'))),
      true,
      'the inline block must carry the class, not just the popup'
    );
    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('.rs-inline .rs-pin-btn')).opacity)),
      '0',
      'and its controls must start hidden'
    );
  });

  /** The relative-time labels actually painted in each section. */
  const TIMES = run((popupSel) => {
    const q = (s) => Array.from(document.querySelectorAll(popupSel + ' ' + s));
    const text = (el) => el.textContent.trim();
    return {
      recent: q('.rs-section:not(.rs-pinned-section) .rs-item .rs-time').map(text),
      pinned: q('.rs-pinned-section .rs-item .rs-time').map(text),
      recentRows: q('.rs-section:not(.rs-pinned-section) .rs-item').length,
      pinnedRows: q('.rs-pinned-section .rs-item').length,
    };
  }, POPUP);

  test('timestamps: shown by default, on both Recent and Pinned rows', async () => {
    await open();
    await openPopup();

    const times = await b.evaluate(TIMES);
    assert.ok(times.recent.length > 0, 'the Recent rows must show a time by default');
    assert.ok(times.pinned.length > 0, 'the Pinned row must show a time by default too');
    // The seed pins r/linux, whose timestamp lives in `recent` — the lookup that
    // makes a pinned row show a time at all.
    assert.match(times.pinned[0], /ago|just now/, `expected a relative time, got "${times.pinned[0]}"`);
  });

  test('timestamps: seeding the option off removes the labels entirely', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&settings=${settingsParam({ showTimestamps: false })}`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    const times = await b.evaluate(TIMES);
    assert.equal(times.recent.length, 0, 'no Recent row may carry a time');
    assert.equal(times.pinned.length, 0, 'nor a Pinned row');
    // The rows themselves must still be there — the option hides the label, not
    // the entry.
    assert.ok(times.recentRows > 0, 'the Recent rows must still render');
    assert.ok(times.pinnedRows > 0, 'the Pinned rows must still render');
  });

  test('timestamps: the settings checkbox persists the choice', async () => {
    await open();
    await openSettings();

    assert.equal(
      await b.evaluate(run(() => document.querySelector('[data-role="show-timestamps"]').checked)),
      true,
      'the checkbox must reflect the default'
    );

    await b.evaluate(run(() => {
      const cb = document.querySelector('[data-role="show-timestamps"]');
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).showTimestamps,
      false,
      'the choice must be persisted'
    );

    // Applied to the live list, not only on the next mount. The panel is open,
    // so close it to read the list view the user would see.
    await b.evaluate(run(() => document.querySelector('.rs-back-btn').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      'settings to close'
    );
    assert.equal(
      (await b.evaluate(TIMES)).recent.length,
      0,
      'the labels must disappear without a reopen'
    );

    // Reset restores it — a restore, not a wipe.
    await openPanel('settings to reopen');
    await b.evaluate(run(() => document.querySelector('[data-role="reset"]').click()));
    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).showTimestamps,
      true,
      'reset must turn them back on'
    );
  });

  test('timestamps: age while the popup stays open', async () => {
    // Tech debt #10: formatTimeAgo ran at render only, so an open popup showed
    // "just now" forever. The fix is a periodic re-render, and this observes a
    // REAL tick of that timer — ?fastIntervals=100 divides the 30s interval down
    // to 300ms of actual elapsed time, so nothing here is simulated.
    await b.goto(
      `${fixtureUrl({ recent: [{ name: 'aging', visitedAt: Date.now() }], pinned: [] })}&fastIntervals=100`
    );
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    // Opening the popup is what starts the refresh timer.
    await openPopup();

    const readTime = run((popupSel) => {
      const el = document.querySelector(popupSel + ' .rs-time');
      return el ? el.textContent.trim() : null;
    }, POPUP);

    assert.equal(await b.evaluate(readTime), 'just now', 'a visit from now must read "just now"');

    // Backdate the stored visit. Nothing touches the DOM from here on — if the
    // label changes, the timer is what changed it.
    await b.evaluate(run(() => {
      const data = JSON.parse(window.__store.recentSubreddits);
      data.recent[0].visitedAt = Date.now() - 5 * 60_000;
      window.__store.recentSubreddits = JSON.stringify(data);
      return true;
    }));

    await b.waitUntil(
      run((popupSel) => {
        const el = document.querySelector(popupSel + ' .rs-time');
        return !!el && el.textContent.trim() === '5m ago';
      }, POPUP),
      'the open popup to re-render the aged timestamp'
    );
  });

  test('timestamps: the refresh timer stops when the popup closes', async () => {
    // The timer is started on open; leaving it running would re-render a hidden
    // popup forever. A re-render replaces .rs-content's innerHTML, so a marker
    // attribute set on a row survives exactly when no re-render happened — which
    // makes "the timer stopped" directly observable, with the open case as the
    // positive control in the same test.
    await b.goto(
      `${fixtureUrl({ recent: [{ name: 'aging', visitedAt: Date.now() }], pinned: [] })}&fastIntervals=100`
    );
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    // One interval is 300ms at this divisor; several make the wait unambiguous.
    const TICK_MS = 300;
    const MARK = 'data-probe';
    const markerSurvives = run((args) => {
      const [popupSel, mark] = args;
      const el = document.querySelector(popupSel + ' .rs-time');
      return !!el && el.getAttribute(mark) === '1';
    }, [POPUP, MARK]);
    const setMarker = run((args) => {
      const [popupSel, mark] = args;
      const el = document.querySelector(popupSel + ' .rs-time');
      if (el) el.setAttribute(mark, '1');
      return true;
    }, [POPUP, MARK]);

    // Control: while OPEN, the timer re-renders and the marker is wiped.
    await b.evaluate(setMarker);
    await new Promise((r) => setTimeout(r, TICK_MS * 3));
    assert.equal(
      await b.evaluate(markerSurvives),
      false,
      'while open, the periodic refresh must re-render the list'
    );

    // Now closed: the marker must survive, i.e. nothing re-rendered.
    await b.evaluate(run(() => document.querySelector('.rs-close-btn').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('visible'), POPUP),
      'popup to close'
    );
    await b.evaluate(setMarker);
    await new Promise((r) => setTimeout(r, TICK_MS * 3));
    assert.equal(
      await b.evaluate(markerSurvives),
      true,
      'a closed popup must not be re-rendered — the timer has to stop'
    );
  });

  /** The subreddit names painted in each section, in order, without the r/ prefix. */
  const NAMES = run((popupSel) => {
    const q = (s) => Array.from(document.querySelectorAll(popupSel + ' ' + s));
    const bare = (el) => el.textContent.trim().replace(/^r\//, '');
    return {
      recent: q('.rs-section:not(.rs-pinned-section) .rs-link').map(bare),
      pinned: q('.rs-pinned-section .rs-link').map(bare),
    };
  }, POPUP);

  test('history size: lowering the cap prunes the stored list immediately', async () => {
    // A seed well over the cap, so the setting has something to cut.
    const seed = {
      recent: Array.from({ length: 8 }, (_, i) => ({ name: `sub${i}`, visitedAt: Date.now() - i * 60_000 })),
      pinned: [],
    };
    await b.goto(`${fixtureUrl(seed)}&settings=${settingsParam({ maxRecent: 8 })}`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    assert.equal((await b.evaluate(NAMES)).recent.length, 8, 'all 8 must render to start');

    // Lower it through the real settings control.
    await openPanel();
    await b.evaluate(run(() => {
      const headers = document.querySelectorAll('.rs-acc-header');
      headers[headers.length - 1].click(); // Display options is the last section
      return true;
    }));
    await b.evaluate(run(() => {
      const input = document.querySelector('[data-role="max-recent"]');
      input.value = '3';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).maxRecent,
      3,
      'the choice must be persisted'
    );
    // Pruned in the store, not merely hidden by the renderer.
    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits))).recent.length,
      3,
      'lowering the cap must prune what is already stored'
    );

    await b.evaluate(run(() => document.querySelector('.rs-back-btn').click()));
    await b.waitUntil(
      run((popupSel) => !document.querySelector(popupSel).classList.contains('settings-open'), POPUP),
      'settings to close'
    );
    const names = (await b.evaluate(NAMES)).recent;
    assert.equal(names.length, 3, 'the list must shrink to the cap');
    assert.deepEqual(names, ['sub0', 'sub1', 'sub2'], 'and keep the newest, in order');
  });

  test('history size: pinned subreddits are exempt from the cap', async () => {
    // The pinned row must survive a cap that would otherwise cut it, and it must
    // not consume one of the unpinned slots.
    const seed = {
      recent: [
        { name: 'newest', visitedAt: Date.now() },
        { name: 'older', visitedAt: Date.now() - 60_000 },
        { name: 'oldest-pinned', visitedAt: Date.now() - 120_000 },
      ],
      pinned: ['oldest-pinned'],
    };
    await b.goto(`${fixtureUrl(seed)}&settings=${settingsParam({ maxRecent: 1 })}`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    const names = await b.evaluate(NAMES);
    assert.deepEqual(names.pinned, ['oldest-pinned'], 'the pinned row must still be there');
    assert.deepEqual(
      names.recent,
      ['newest'],
      'and the cap must apply to the unpinned rows only'
    );

    // Its timestamp must survive too — that is the data a plain slice would drop.
    const times = await b.evaluate(TIMES);
    assert.equal(times.pinned.length, 1, 'the pinned row must still show a time');
    assert.match(times.pinned[0], /ago|just now/, `expected a relative time, got "${times.pinned[0]}"`);
  });

  test('history size: an over-cap stored list is trimmed on read, not just on write', async () => {
    // A store seeded over the cap (a hand-edit, or a list written before the cap
    // was lowered). The write path is not involved here, so this is what proves
    // loadData() applies the cap — otherwise the list would paint in full.
    //
    // Note: the visit-write path itself cannot be driven here. The fixture is a
    // file:// page, so location.pathname has no /r/<name>/ and trackVisit() never
    // runs — tech debt #4. That path is covered by the unit suite instead.
    const seed = {
      recent: Array.from({ length: 6 }, (_, i) => ({ name: `sub${i}`, visitedAt: Date.now() - i * 60_000 })),
      pinned: ['sub5'],
    };
    await b.goto(`${fixtureUrl(seed)}&settings=${settingsParam({ maxRecent: 2 })}`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');
    await openPopup();

    const names = await b.evaluate(NAMES);
    assert.deepEqual(names.recent, ['sub0', 'sub1'], 'only the newest unpinned rows may render');
    assert.deepEqual(names.pinned, ['sub5'], 'and the pinned row must be exempt');
  });

  test('history size: the input reflects the default and rejects junk', async () => {
    await open();
    await openSettings();
    await b.evaluate(run(() => {
      const headers = document.querySelectorAll('.rs-acc-header');
      headers[headers.length - 1].click();
      return true;
    }));

    assert.equal(
      await b.evaluate(run(() => document.querySelector('[data-role="max-recent"]').value)),
      '15',
      'the field must show the default cap'
    );

    // A junk value falls back to the default rather than emptying the list, and
    // the field is rewritten so the user sees what was actually applied.
    await b.evaluate(run(() => {
      const input = document.querySelector('[data-role="max-recent"]');
      input.value = 'not-a-number';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).maxRecent,
      15,
      'junk must fall back to the default'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelector('[data-role="max-recent"]').value)),
      '15',
      'and the field must show the applied value'
    );

    // An out-of-range value is clamped, and the field shows the clamped number.
    await b.evaluate(run(() => {
      const input = document.querySelector('[data-role="max-recent"]');
      input.value = '0';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));
    assert.equal(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).maxRecent,
      1,
      '0 must clamp to the minimum'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelector('[data-role="max-recent"]').value)),
      '1',
      'and the field must show the clamped value'
    );
  });

  test('close button sits at the end of the header row, aligned with the popup edge', async () => {
    await open();
    await openPopup();

    const geo = await b.evaluate(run((popupSel) => {
      const popup = document.querySelector(popupSel);
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
    }, POPUP));

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
    await openSettings('settings panel open');

    const ESC = `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`;
    await b.evaluate(ESC);
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP)),
      false,
      'first Escape closes the modal'
    );
    assert.equal(await b.evaluate(isVisible), true, 'popup stays open after the first Escape');

    await b.evaluate(ESC);
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'second Escape closes the popup');
  });

  // ---- Live element picker ----

  test('picker: hovering outlines an element and clicking adds it as a hook target', async () => {
    await open();
    await openSettings('settings panel open');

    // Start picking. The popup must get out of the way so the page is pickable.
    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(
      run(() => !!document.getElementById('rs-picker-hint')),
      'picker overlay to appear'
    );
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('visible'), POPUP)),
      false,
      'the popup must close so the whole page can be picked'
    );

    // Hover the target: the outline box follows it and the hint names a selector.
    await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      return true;
    }));
    const hovered = await b.evaluate(run(() => {
      const box = document.getElementById('rs-picker-box');
      const hint = document.getElementById('rs-picker-hint');
      const r = document.querySelector('#pick-target').getBoundingClientRect();
      return {
        display: getComputedStyle(box).display,
        boxW: Math.round(box.getBoundingClientRect().width),
        targetW: Math.round(r.width),
        hint: hint.textContent,
      };
    }));
    assert.equal(hovered.display, 'block', 'the outline box must be shown while hovering');
    assert.ok(
      Math.abs(hovered.boxW - hovered.targetW) <= 2,
      `outline must match the hovered element, got ${JSON.stringify(hovered)}`
    );
    assert.match(hovered.hint, /pick-target/, `hint should name the selector, got: ${hovered.hint}`);

    // Click it: the pick is taken, the overlay goes away, the target is stored.
    const picked = await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      return {
        prevented: ev.defaultPrevented,
        overlayGone: !document.getElementById('rs-picker-hint') && !document.getElementById('rs-picker-box'),
      };
    }));
    assert.equal(picked.prevented, true, 'the pick click must be swallowed, not passed to the page');
    assert.equal(picked.overlayGone, true, 'the picker overlay must be removed after a pick');

    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings)));
    assert.deepEqual(
      stored.targets,
      [BUILTIN_HOOK, { selector: '#pick-target', mode: 'hook', events: 'both' }],
      'the picked element must be saved as a hook target'
    );

    // The settings UI came back and lists it.
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP)),
      true,
      'settings must reopen after a pick'
    );
    // Assert by predicate, not by row position: the picked target must be
    // listed, regardless of where it sits relative to the built-in hook.
    assert.equal(
      await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-target-sel'))
        .some((c) => c.textContent === '#pick-target'))),
      true,
      'the target must be listed in settings'
    );
  });

  test('picker: after picking, the Page targets section is open', async () => {
    await open();
    await openSettings('settings panel open');

    // Pick an element.
    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');
    await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }));
    await b.waitUntil(run(() => !document.getElementById('rs-picker-hint')), 'picker closed');

    // The Page targets section (index 1) must be open, not the default Hotkey.
    const state = await b.evaluate(run(() => {
      const sections = document.querySelectorAll('.rs-acc-section');
      return {
        openIndex: Array.from(sections).findIndex((s) => s.classList.contains('rs-acc-open')),
        total: sections.length,
      };
    }));
    assert.equal(state.total, 4, 'there should be four accordion sections');
    assert.equal(state.openIndex, 1, 'the Page targets section must be open after a pick');
  });

  test('picker: after Escape, the Page targets section is open', async () => {
    await open();
    await openSettings('settings panel open');

    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');
    await b.evaluate(run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))));
    await b.waitUntil(run(() => !document.getElementById('rs-picker-hint')), 'picker closed');

    const state = await b.evaluate(run(() => {
      const sections = document.querySelectorAll('.rs-acc-section');
      return Array.from(sections).findIndex((s) => s.classList.contains('rs-acc-open'));
    }));
    assert.equal(state, 1, 'the Page targets section must be open after cancelling');
  });

  test('inline block: Done returns to the main view', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    // Open settings from the inline gear.
    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-settings-btn').click()));
    await b.waitUntil(
      run(() => document.querySelector('.rs-inline').classList.contains('settings-open')),
      'inline settings open'
    );

    // Click Done.
    await b.evaluate(run(() => document.querySelector('.rs-inline [data-role="done"]').click()));
    await b.waitUntil(
      run(() => !document.querySelector('.rs-inline').classList.contains('settings-open')),
      'inline settings to close'
    );

    const state = await b.evaluate(run(() => {
      const inst = document.querySelector('.rs-inline');
      return {
        settingsOpen: inst.classList.contains('settings-open'),
        listVisible: getComputedStyle(inst.querySelector('.rs-content')).display !== 'none',
        panelHidden: getComputedStyle(inst.querySelector('.rs-settings-panel')).display === 'none',
      };
    }));
    assert.equal(state.settingsOpen, false, 'settings-open class must be removed');
    assert.equal(state.listVisible, true, 'the list view must be visible again');
    assert.equal(state.panelHidden, true, 'the settings panel must be hidden');
  });

  test('picker: Escape cancels without adding a target', async () => {
    await open();
    await openSettings('settings panel open');

    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');

    await b.evaluate(run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))));
    await b.waitUntil(
      run(() => !document.getElementById('rs-picker-hint')),
      'picker overlay to be removed by Escape'
    );

    assert.deepEqual(
      JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings))).targets,
      [BUILTIN_HOOK],
      'cancelling must not add a target'
    );
    assert.equal(
      await b.evaluate(run((popupSel) => document.querySelector(popupSel).classList.contains('settings-open'), POPUP)),
      true,
      'settings must come back after cancelling'
    );
  });

  test('picker: an already-configured element is not added twice', async () => {
    await open();
    await openSettings('settings panel open');

    // Pick the same element twice.
    for (let i = 0; i < 2; i++) {
      await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
      await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), `picker active (${i})`);
      await b.evaluate(run(() => {
        const el = document.querySelector('#pick-target');
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      }));
      await b.waitUntil(run(() => !document.getElementById('rs-picker-hint')), `picker closed (${i})`);
    }

    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubredditsSettings)));
    // One seeded built-in hook + exactly one picked entry.
    assert.equal(stored.targets.length, 2, `duplicate pick must not add a second entry, got ${JSON.stringify(stored.targets)}`);
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-target').length)),
      2,
      'the list must show the built-in hook plus the single picked row'
    );
  });

  test('selector builder prefers an id, then a test id, then a path', async () => {
    await open();
    await openSettings();

    // Read the selector the picker proposes for an element, without committing it.
    const propose = async (sel) => {
      await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
      await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');
      const text = await b.evaluate(run((selArg) => {
        const el = document.querySelector(selArg);
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
        return document.getElementById('rs-picker-hint').textContent;
      }, sel));
      await b.evaluate(run(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))));
      await b.waitUntil(run(() => !document.getElementById('rs-picker-hint')), 'picker closed');
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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup mounted');

    assert.equal(await b.evaluate(isVisible), false, 'popup starts hidden');

    await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      const o = { bubbles: true, cancelable: true, relatedTarget: document.body };
      el.dispatchEvent(new MouseEvent('mouseover', o));
      return true;
    }));
    await b.waitUntil(isVisible, 'popup to open from the hooked element');

    // Anchored to the hooked element, not centred.
    const geo = await b.evaluate(run((popupSel) => {
      const t = document.querySelector('#pick-target').getBoundingClientRect();
      const p = document.querySelector(popupSel).getBoundingClientRect();
      return { triggerBottom: t.bottom, popupTop: p.top };
    }, POPUP));
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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'mounted');
    await b.evaluate(clickTarget);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await b.evaluate(isVisible), false, 'a hover-only hook must ignore clicks');

    await b.evaluate(hoverTarget);
    await b.waitUntil(isVisible, 'hover-only hook opens on hover');

    // --- click only ---
    await b.goto(seed('click'));
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'mounted');
    await b.evaluate(hoverTarget);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(await b.evaluate(isVisible), false, 'a click-only hook must ignore hover');

    await b.evaluate(clickTarget);
    await b.waitUntil(isVisible, 'click-only hook opens on click');
  });

  test('changing a target mode to replace persists it', async () => {
    await open();
    await openSettings();

    // Pick an element, then switch its mode.
    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');
    await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }));
    await b.waitUntil(run(() => !document.getElementById('rs-picker-hint')), 'picker closed');

    const changed = await b.evaluate(run(() => {
      // Find the row for the target just picked, by its selector — the seeded
      // built-in hook is another row, and a positional pick would silently
      // follow whichever order the rows happen to be in.
      const row = Array.from(document.querySelectorAll('.rs-target'))
        .find((li) => li.querySelector('.rs-target-sel').textContent === '#pick-target');
      const sel = row.querySelector('[data-role="mode"]');
      sel.value = 'replace';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));
    assert.equal(changed, true);

    await b.waitUntil(
      run(() => JSON.parse(window.__store.recentSubredditsSettings)
        .targets.find((t) => t.selector === '#pick-target')?.mode === 'replace'),
      'the mode change to be persisted'
    );

    // A replace target has no event choice — the control is gone for that row,
    // while the built-in hook still has one.
    assert.equal(
      await b.evaluate(run(() => {
        const row = Array.from(document.querySelectorAll('.rs-target'))
          .find((li) => li.querySelector('.rs-target-sel').textContent === '#pick-target');
        return row.querySelector('[data-role="events"]') === null;
      })),
      true,
      'the events selector must not be offered for a non-hook mode'
    );
  });

  test('removing a target persists the removal', async () => {
    await open();
    await openSettings();

    await b.evaluate(run(() => document.querySelector('[data-role="pick"]').click()));
    await b.waitUntil(run(() => !!document.getElementById('rs-picker-hint')), 'picker active');
    await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return true;
    }));
    await b.waitUntil(run(() => document.querySelectorAll('.rs-target').length === 2), 'target listed');

    // Remove the picked row (the last one); the built-in hook stays.
    await b.evaluate(run(() => {
      const btns = document.querySelectorAll('[data-role="remove"]');
      btns[btns.length - 1].click();
      return true;
    }));
    await b.waitUntil(
      run(() => JSON.parse(window.__store.recentSubredditsSettings).targets.length === 1),
      'the removal to be persisted'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-target').length)),
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
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup mounted');

    // Two survive, each repaired to a valid mode/events.
    await openSettings();

    const rows = await b.evaluate(run(() => Array.from(document.querySelectorAll('.rs-target')).map(li => ({
      sel: li.querySelector('.rs-target-sel').textContent,
      mode: li.querySelector('[data-role="mode"]').value,
      events: li.querySelector('[data-role="events"]')?.value ?? null,
    }))));
    assert.deepEqual(
      rows,
      [
        { sel: '#pick-target', mode: 'hook', events: 'both' },
        { sel: '#logo', mode: 'hook', events: 'both' },
      ],
      `malformed entries should be dropped and the rest repaired, got ${JSON.stringify(rows)}`
    );

    assert.deepEqual(await b.evaluate(run(() => window.__errors)), [], 'a bad store must not throw');
  });

  // ---- Inline modes (replace / prepend / append) ----

  test('inline replace: hides the element, nests the UI inside it without leaving a gap, keeps the binding alive', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'replace' }] })
    );
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const state = await b.evaluate(run(() => {
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
    }));

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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const widths = await b.evaluate(run(() => {
      const el = document.querySelector('#pick-target');
      // Measure the element while it is still laid out (visibility, not display).
      const w = el.getBoundingClientRect().width;
      const inst = document.querySelector('.rs-inline');
      return { elW: Math.round(w), instW: Math.round(inst.getBoundingClientRect().width), css: inst.style.width };
    }));
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const geo = await b.evaluate(run(() => {
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
    }));

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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('#pick-target')).position)),
      'relative',
      'a static replace target must be promoted to a containing block'
    );

    // Drop the binding: the element goes back to how the page had it.
    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-close-btn').click()));
    await b.waitUntil(run(() => !document.querySelector('.rs-inline-host')), 'the block to be removed');

    assert.equal(
      await b.evaluate(run(() => document.querySelector('#pick-target').style.position)),
      '',
      'the promoted position must be reverted on teardown'
    );
    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('#pick-target')).position)),
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    assert.equal(
      await b.evaluate(run(() => document.querySelector('#positioned-target').style.position)),
      'relative',
      "the page's own positioning must be left exactly as it was"
    );
    // And the block still lands on it — no promotion was needed.
    const geo = await b.evaluate(run(() => {
      const el = document.querySelector('#positioned-target').getBoundingClientRect();
      const inst = document.querySelector('.rs-inline').getBoundingClientRect();
      return { dx: Math.round(inst.left - el.left), dy: Math.round(inst.top - el.top) };
    }));
    assert.ok(
      Math.abs(geo.dx) <= 2 && Math.abs(geo.dy) <= 2,
      `the block must overlap an already-positioned element, got ${JSON.stringify(geo)}`
    );

    // Teardown must not clear a value it did not set.
    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-close-btn').click()));
    await b.waitUntil(run(() => !document.querySelector('.rs-inline-host')), 'the block to be removed');
    assert.equal(
      await b.evaluate(run(() => document.querySelector('#positioned-target').style.position)),
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const state = await b.evaluate(run(() => {
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
    }));

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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-close-btn').click()));
    await b.waitUntil(run(() => !document.querySelector('.rs-inline-host')), 'the block to be removed');

    const after = await b.evaluate(run(() => {
      const target = document.querySelector('#override-target');
      const inner = document.querySelector('#override-inner');
      return {
        marked: target.classList.contains('rs-replacing'),
        innerVisibility: getComputedStyle(inner).visibility,
      };
    }));
    assert.equal(after.marked, false, 'the marker must be removed on teardown');
    assert.equal(after.innerVisibility, 'visible', 'the original content must come back');
  });

  test('inline prepend: inserts the UI as the first child, element untouched', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#content', mode: 'prepend' }] })
    );
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const state = await b.evaluate(run(() => {
      const el = document.querySelector('#content');
      const host = document.querySelector('.rs-inline-host');
      return {
        firstChild: el.firstElementChild === host,
        inside: el.contains(host),
        visibility: getComputedStyle(el).visibility,
      };
    }));
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    const state = await b.evaluate(run(() => {
      const el = document.querySelector('#content');
      const host = document.querySelector('.rs-inline-host');
      return {
        lastChild: el.lastElementChild === host,
        inside: el.contains(host),
        visibility: getComputedStyle(el).visibility,
      };
    }));
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-close-btn').click()));
    await b.waitUntil(run(() => !document.querySelector('.rs-inline-host')), 'the block to be removed');

    assert.deepEqual(
      await b.evaluate(run(() => JSON.parse(window.__store.recentSubredditsSettings).targets)),
      [],
      'the binding must be removed from settings'
    );
    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('#pick-target')).visibility)),
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-pin-btn[data-name="javascript"]').click()));
    await b.waitUntil(
      run(() => document.querySelectorAll('.rs-inline .rs-pinned .rs-link').length === 2),
      'the inline list to show the new pin'
    );

    const stored = JSON.parse(await b.evaluate(run(() => window.__store.recentSubreddits)));
    assert.deepEqual(stored.pinned, ['javascript', 'linux'], 'the pin must be persisted');
  });

  test('inline block: settings open from its own gear and swap in place', async () => {
    await b.goto(
      fixtureUrl(DEFAULT_SEED) +
        '&settings=' +
        settingsParam({ targets: [{ selector: '#pick-target', mode: 'append' }] })
    );
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');

    await b.evaluate(run(() => document.querySelector('.rs-inline .rs-settings-btn').click()));
    await b.waitUntil(
      run(() => document.querySelector('.rs-inline').classList.contains('settings-open')),
      'the inline panel to open'
    );

    const state = await b.evaluate(run(() => {
      const inst = document.querySelector('.rs-inline');
      return {
        title: inst.querySelector('.rs-header').textContent,
        panelShown: getComputedStyle(inst.querySelector('.rs-settings-panel')).display,
        listHidden: getComputedStyle(inst.querySelector('.rs-content')).display,
        // Opening the inline panel must NOT open the popup's.
        popupPanel: document.querySelector('.recent-subreddits-popup').classList.contains('settings-open'),
      };
    }));
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'inline block to mount');
    assert.equal(
      await b.evaluate(run(() => document.querySelector('#content').lastElementChild.classList.contains('rs-inline-host'))),
      true,
      'starts appended'
    );

    // Open the popup's settings and change the mode there. By hotkey: this test
    // supplies its own targets, so the seeded built-in hook is not present.
    await b.evaluate(PRESS('Alt+Shift+r'));
    await b.waitUntil(isVisible, 'popup open');
    // Scoped to the popup: this page also has an inline block carrying its own
    // gear, and an unscoped .rs-settings-btn would click that one instead.
    await b.evaluate(run(() => document.querySelector('.recent-subreddits-popup .rs-settings-btn').click()));
    await b.waitUntil(
      run(() => document.querySelector('.recent-subreddits-popup').classList.contains('settings-open')),
      'popup settings open'
    );

    await b.evaluate(run(() => {
      const sel = document.querySelector('.recent-subreddits-popup [data-role="mode"]');
      sel.value = 'prepend';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }));

    await b.waitUntil(
      run(() => document.querySelector('#content').firstElementChild?.classList.contains('rs-inline-host')),
      'the block to move to the front after the mode change'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-inline-host').length)),
      1,
      'relocating must not duplicate the block'
    );
    assert.equal(
      await b.evaluate(run(() => getComputedStyle(document.querySelector('#content')).visibility)),
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
    await b.waitUntil(run(() => !!document.querySelector('.recent-subreddits-popup')), 'popup mounted');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-inline-host').length)),
      0,
      'nothing should mount for an unmatched selector'
    );
    assert.deepEqual(await b.evaluate(run(() => window.__errors)), [], 'a missing element must not throw');
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
    await b.waitUntil(run(() => !!document.querySelector('.rs-inline')), 'the valid target to mount');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-inline-host').length)),
      1,
      'the valid target must still mount despite the invalid sibling'
    );
    assert.deepEqual(await b.evaluate(run(() => window.__errors)), [], 'an invalid selector must not throw');
  });

  test('the built-in trigger ships as a settings target and reset restores it', async () => {
    // The built-in Reddit trigger used to be a hardcoded fallback. It is an
    // ordinary settings entry now, which is what makes it visible and removable —
    // and what makes "reset" able to put it back.
    await open();
    await openSettings();

    // It is listed, with the full built-in selector.
    const listed = await b.evaluate(run(() => {
      const sel = document.querySelector('.rs-target-sel');
      return { text: sel.textContent, title: sel.title };
    }));
    assert.match(listed.title, /top-nav-logo/, 'the built-in selector must be the listed target');
    assert.match(listed.title, /navbar-menu-button/, 'and must cover the whole combined selector');

    // Delete it, then confirm the list says the popup is hotkey-only.
    await b.evaluate(run(() => document.querySelector('[data-role="remove"]').click()));
    await b.waitUntil(
      run(() => JSON.parse(window.__store.recentSubredditsSettings).targets.length === 0),
      'the built-in target to be removed'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-target').length)),
      0,
      'removing it must leave no rows'
    );
    assert.match(
      await b.evaluate(run(() => document.querySelector('.rs-warn').textContent)),
      /Alt\+Shift\+R/,
      'with no hook, settings must point at the hotkey'
    );
    // Hover must genuinely stop opening the popup.
    await b.evaluate(run(() => document.querySelector('[data-role="done"]').click()));
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'popup closed');
    await b.evaluate(HOVER('#logo'));
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(await b.evaluate(isVisible), false, 'with no hook, hovering must not open the popup');

    // Reset restores it — a restore, not a wipe.
    await b.evaluate(PRESS('Alt+Shift+r'));
    await openPanel('settings open again');
    await b.evaluate(run(() => document.querySelector('[data-role="reset"]').click()));
    await b.waitUntil(
      run(() => JSON.parse(window.__store.recentSubredditsSettings).targets.length === 1),
      'reset to restore a target'
    );
    assert.equal(
      await b.evaluate(run(() => document.querySelectorAll('.rs-target').length)),
      1,
      'reset must restore the built-in trigger row'
    );
    assert.equal(
      await b.evaluate(run(() => !!document.querySelector('.rs-warn'))),
      false,
      'the hotkey-only warning must be gone once a hook is restored'
    );

    // And hover works again.
    await b.evaluate(run(() => document.querySelector('[data-role="done"]').click()));
    await b.evaluate(CLICK_BODY);
    await b.waitUntil(run(() => !document.querySelector('.recent-subreddits-popup')?.classList.contains('visible')), 'popup closed');
    await openPopup('hover to open the popup again after reset');
  });

  test('WARNS once when no trigger selector matches', async () => {
    await b.goto(`${fixtureUrl(DEFAULT_SEED)}&noTriggers=1`);
    await b.waitUntil(run((popupSel) => !!document.querySelector(popupSel), POPUP), 'popup to mount');

    const warns = await b.waitUntil(
      run(() => window.__warns.length > 0 ? window.__warns : null),
      'a warning about the missing trigger'
    );
    assert.equal(warns.length, 1, `expected exactly one warning, got ${JSON.stringify(warns)}`);
    assert.match(warns[0], /none of the configured hooks matched/i);
    assert.match(warns[0], /recent-subreddits/, 'warning should be prefixed so it is identifiable');

    // Navigating must not spam the console with a repeat.
    await b.evaluate(run(() => document.body.appendChild(document.createElement('span'))));
    await b.evaluate(CLICK_BODY);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      await b.evaluate(run(() => window.__warns.length)),
      1,
      'the warning must not repeat'
    );
  });

  test('does NOT warn when the trigger is present', async () => {
    await open();
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(
      await b.evaluate(run(() => window.__warns)),
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
