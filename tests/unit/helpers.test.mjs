// Unit tests: no browser, no network. These must stay green on a machine
// without Chromium, which is why the e2e suite lives in its own tree/script.
//
// The helpers are imported from src/ directly. Before the source was split into
// modules the tests had to brace-match functions out of the built userscript,
// because it was one IIFE with no exports.
//
// Run:  npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseHotkey, hotkeyMatches, comboFromEvent } from '../../src/hotkey.js';
import { formatTimeAgo } from '../../src/time.js';
import { getSubredditFromUrl } from '../../src/visits.js';
import { ICON_MAX_ATTEMPTS, ICON_RETRY_DELAYS } from '../../src/icons.js';
import { trackVisit, removeVisit } from '../../src/visits.js';
import { loadSettings, defaultSettings, DEFAULT_SETTINGS } from '../../src/storage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = join(HERE, '..', '..', 'recent-subreddits.user.js');

describe('metadata block', () => {
  // Read the BUILT file, not src/userscript.meta.js: the grants that matter are
  // the ones Tampermonkey actually sees, and the banner is only prepended at
  // build time. This catches a banner that fails to land.
  const source = readFileSync(BUILT, 'utf8');

  test('the metadata block is the very first thing in the built file', () => {
    assert.match(source, /^\/\/ ==UserScript==/, 'Tampermonkey only reads a banner at the top');
  });

  test('declares every GM_* API the script calls', () => {
    const meta = source.slice(0, source.indexOf('==/UserScript=='));
    const granted = new Set(
      [...meta.matchAll(/^\/\/\s*@grant\s+(\S+)/gm)].map((m) => m[1])
    );

    // An undeclared GM_* call is `undefined` at runtime and kills the script.
    for (const api of ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest']) {
      assert.ok(granted.has(api), `${api} is called but not @grant-ed`);
    }
  });

  test('@connect covers the host the script fetches from', () => {
    const meta = source.slice(0, source.indexOf('==/UserScript=='));
    assert.match(meta, /@connect\s+reddit\.com/, 'GM_xmlhttpRequest needs @connect reddit.com');
  });
});

describe('formatTimeAgo', () => {
  const now = Date.now();

  test('renders each unit at its boundary', () => {
    const cases = [
      [30_000, 'just now'],
      [59_000, 'just now'],
      [60_000, '1m ago'],
      [59 * 60_000, '59m ago'],
      [60 * 60_000, '1h ago'],
      [23 * 3_600_000, '23h ago'],
      [24 * 3_600_000, '1d ago'],
      [72 * 3_600_000, '3d ago'],
    ];
    for (const [ago, expected] of cases) {
      assert.equal(formatTimeAgo(now - ago), expected, `${ago}ms ago`);
    }
  });
});

describe('getSubredditFromUrl', () => {

  /** Call the real function with a stubbed location. */
  function withPath(path) {
    const prev = globalThis.window;
    globalThis.window = { location: { pathname: path } };
    try {
      return getSubredditFromUrl();
    } finally {
      if (prev === undefined) delete globalThis.window;
      else globalThis.window = prev;
    }
  }

  test('extracts and lowercases the subreddit name', () => {
    assert.equal(withPath('/r/JavaScript/'), 'javascript');
    assert.equal(withPath('/r/webdev/comments/abc/title/'), 'webdev');
    assert.equal(withPath('/r/linux'), 'linux');
  });

  test('returns null for non-subreddit paths', () => {
    assert.equal(withPath('/'), null);
    assert.equal(withPath('/user/someone'), null);
    assert.equal(withPath('/r/'), null);
  });
});

describe('hotkey parsing', () => {
  test('parses a modifier + key combo', () => {
    assert.deepEqual(parseHotkey('Alt+Shift+R'), {
      ctrl: false,
      alt: true,
      shift: true,
      meta: false,
      key: 'r',
    });
  });

  test('accepts modifier aliases and is case-insensitive', () => {
    const a = parseHotkey('control+option+k');
    assert.equal(a.ctrl, true);
    assert.equal(a.alt, true);
    assert.equal(a.key, 'k');
    assert.equal(parseHotkey('CMD+J').meta, true);
  });

  test('rejects a bare modifier (not a shortcut)', () => {
    assert.equal(parseHotkey('Alt'), null);
    assert.equal(parseHotkey('Shift+Ctrl'), null);
    assert.equal(parseHotkey(''), null);
  });

  test('matches a real keydown', () => {
    const combo = parseHotkey('Alt+Shift+R');
    assert.equal(
      hotkeyMatches({ key: 'R', ctrlKey: false, altKey: true, shiftKey: true, metaKey: false }, combo),
      true,
      'shift makes event.key uppercase — must still match'
    );
    assert.equal(
      hotkeyMatches({ key: 'r', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }, combo),
      false,
      'missing shift must not match'
    );
    assert.equal(
      hotkeyMatches({ key: 'R', ctrlKey: false, altKey: true, shiftKey: true, metaKey: true }, combo),
      false,
      'an extra modifier must not match'
    );
  });

  test('never matches when the combo is unparseable', () => {
    assert.equal(
      hotkeyMatches({ key: 'a', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, null),
      false
    );
  });

  test('round-trips a keydown into a stored combo string', () => {
    // The settings field stores what comboFromEvent() produces, and the global
    // handler compares against parseHotkey(). If the two disagree, a captured
    // hotkey silently never fires — the exact bug the module split caused once,
    // so it is pinned down here.
    const event = { key: 'k', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false };
    const combo = comboFromEvent(event);
    assert.equal(combo, 'Ctrl+Shift+K');
    assert.deepEqual(parseHotkey(combo), {
      ctrl: true,
      alt: false,
      shift: true,
      meta: false,
      key: 'k',
    });
    assert.equal(hotkeyMatches(event, parseHotkey(combo)), true);
  });

  test('a modifier-only keydown yields no combo', () => {
    assert.equal(
      comboFromEvent({ key: 'Shift', ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }),
      null
    );
  });
});

describe('icon retry policy', () => {
  // The e2e suite proves the retry happens; these pin the shape of the policy,
  // because the 5-minute cap release is far too slow to wait out in a browser.

  test('every failure gets a backoff delay, and the cap is reachable', () => {
    // recordFailure() indexes ICON_RETRY_DELAYS by attempt number and falls back
    // to the last value. If the array were shorter than the cap, the last
    // attempts would silently share one delay.
    assert.ok(
      ICON_RETRY_DELAYS.length >= ICON_MAX_ATTEMPTS - 1,
      `expected a delay per retry: ${ICON_RETRY_DELAYS.length} delays for ${ICON_MAX_ATTEMPTS} attempts`
    );
    for (const d of ICON_RETRY_DELAYS) {
      assert.ok(typeof d === 'number' && d > 0, `delays must be positive, got ${d}`);
    }
  });

  test('the delays increase, so a blocked subreddit is not hammered', () => {
    for (let i = 1; i < ICON_RETRY_DELAYS.length; i++) {
      assert.ok(
        ICON_RETRY_DELAYS[i] > ICON_RETRY_DELAYS[i - 1],
        `delay ${i} must be longer than ${i - 1}: ${JSON.stringify(ICON_RETRY_DELAYS)}`
      );
    }
  });

  test('more than one attempt is allowed before giving up', () => {
    // A single attempt is the old bug: one 403 and the row is grey forever.
    assert.ok(ICON_MAX_ATTEMPTS > 1, `must retry at least once, got ${ICON_MAX_ATTEMPTS}`);
  });
});

describe('visit tracking and the blacklist', () => {
  // These drive the real functions against a stubbed GM store. The e2e suite
  // cannot cover this: its fixture is a file:// page, so there is no subreddit
  // URL for the tracker to read, and trackVisit() never runs there.

  /** Install a GM store + location, run `fn`, then restore the globals. */
  function withStore(store, pathname, fn) {
    const prev = {
      GM_getValue: globalThis.GM_getValue,
      GM_setValue: globalThis.GM_setValue,
      window: globalThis.window,
    };
    globalThis.GM_getValue = (k, d) => (k in store ? store[k] : d);
    globalThis.GM_setValue = (k, v) => { store[k] = v; };
    globalThis.window = { location: { pathname } };
    try {
      return fn(store);
    } finally {
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete globalThis[k];
        else globalThis[k] = v;
      }
    }
  }

  const readData = (store) => JSON.parse(store.recentSubreddits || '{"recent":[],"pinned":[]}');
  const readSettings = (store) => JSON.parse(store.recentSubredditsSettings || '{"blocked":[]}');

  test('a visit is recorded', () => {
    const store = {};
    withStore(store, '/r/webdev/', () => trackVisit('webdev'));
    assert.deepEqual(readData(store).recent.map((r) => r.name), ['webdev']);
  });

  test('a blacklisted subreddit is never tracked again', () => {
    // This is the whole point of the blacklist, and it is the behaviour the trash
    // button promises when it says "Remove from history".
    const store = {
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: ['webdev'] }),
    };
    withStore(store, '/r/webdev/', () => trackVisit('webdev'));
    assert.deepEqual(
      readData(store).recent,
      [],
      'a blocked subreddit must not be added to history'
    );
  });

  test('a blocked subreddit is not re-added even if it is already in history', () => {
    // The removal drops the row, but history can hold a name that was blocked
    // later (e.g. blocked on another device, or seeded by hand). Visiting it must
    // not resurrect it.
    const store = {
      recentSubreddits: JSON.stringify({ recent: [{ name: 'webdev', visitedAt: 1 }], pinned: [] }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: ['webdev'] }),
    };
    withStore(store, '/r/webdev/', () => trackVisit('webdev'));
    assert.deepEqual(readData(store).recent.map((r) => r.name), ['webdev'], 'unchanged');
  });

  test('removing a visit drops the row and blacklists the name', () => {
    const store = {
      recentSubreddits: JSON.stringify({
        recent: [{ name: 'webdev', visitedAt: 1 }, { name: 'linux', visitedAt: 2 }],
        pinned: [],
      }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [] }),
    };
    withStore(store, '/', () => removeVisit('webdev', () => {}));

    assert.deepEqual(readData(store).recent.map((r) => r.name), ['linux'], 'row dropped');
    assert.deepEqual(readSettings(store).blocked, ['webdev'], 'and blacklisted');
  });

  test('removing twice does not duplicate the blacklist entry', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [{ name: 'webdev', visitedAt: 1 }], pinned: [] }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: ['webdev'] }),
    };
    withStore(store, '/', () => removeVisit('webdev', () => {}));
    assert.deepEqual(readSettings(store).blocked, ['webdev'], 'still one entry');
  });
});

describe('the built-in trigger as a default setting', () => {
  /** Install a GM store, run `fn`, then restore the globals. */
  function withStore(store, fn) {
    const prevGet = globalThis.GM_getValue;
    const prevSet = globalThis.GM_setValue;
    globalThis.GM_getValue = (k, d) => (k in store ? store[k] : d);
    globalThis.GM_setValue = (k, v) => { store[k] = v; };
    try {
      return fn(store);
    } finally {
      if (prevGet === undefined) delete globalThis.GM_getValue; else globalThis.GM_getValue = prevGet;
      if (prevSet === undefined) delete globalThis.GM_setValue; else globalThis.GM_setValue = prevSet;
    }
  }

  test('the defaults carry the built-in hook, so a first run works', () => {
    // The trigger used to be a hardcoded fallback in the resolver. It has to be
    // in the defaults instead, or a fresh install would have hover disabled.
    assert.equal(DEFAULT_SETTINGS.targets.length, 1, 'the defaults must include one target');
    const t = DEFAULT_SETTINGS.targets[0];
    assert.equal(t.mode, 'hook');
    assert.equal(t.events, 'both');
    assert.match(t.selector, /top-nav-logo/, 'the built-in selector must be there');
    assert.match(t.selector, /navbar-menu-button/, 'including the mobile menu button');
  });

  test('the first load seeds those defaults into the store', () => {
    const store = {};
    const s = withStore(store, () => loadSettings());
    assert.equal(s.targets.length, 1, 'the first load must seed a target');
    // Persisted, not just returned: the next load must find it.
    assert.ok(store.recentSubredditsSettings, 'the seeded settings must be written');
    assert.equal(
      JSON.parse(store.recentSubredditsSettings).targets.length,
      1,
      'and the store must hold the target'
    );
  });

  test('a stored empty target list is respected, not re-seeded', () => {
    // Deleting every hook is allowed, so an existing empty list must stay empty:
    // re-seeding here would make the delete impossible to keep.
    const store = {
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: [] }),
    };
    const s = withStore(store, () => loadSettings());
    assert.deepEqual(s.targets, [], 'an explicitly emptied list must not be re-seeded');
  });

  test('defaultSettings() returns a fresh copy, never the shared object', () => {
    // The reset button writes it and the list mutates targets; sharing the
    // module-level array would let one leak into the other.
    const a = defaultSettings();
    const b = defaultSettings();
    assert.notEqual(a.targets, b.targets, 'each call must get its own array');
    assert.notEqual(a.targets[0], b.targets[0], 'and its own target objects');
    a.targets.push({ selector: '#x', mode: 'hook', events: 'both' });
    assert.equal(b.targets.length, 1, 'mutating one copy must not affect another');
    assert.equal(DEFAULT_SETTINGS.targets.length, 1, 'nor the defaults themselves');
  });
});
