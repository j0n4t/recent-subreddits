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
import { trackVisit, removeVisit, movePinned, togglePin } from '../../src/visits.js';
import { loadSettings, defaultSettings, DEFAULT_SETTINGS, pruneRecent, MIN_MAX_RECENT, MAX_MAX_RECENT } from '../../src/storage.js';
import { checkTriggers } from '../../src/diagnostics.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILT = join(HERE, '..', '..', 'recent-subreddits.user.js');
const README = join(HERE, '..', '..', 'README.md');

/**
 * Install a GM store, run `fn`, then restore the globals.
 *
 * Only the GM store is stubbed: the visit-tracking functions under test take the
 * subreddit name as an argument and never read `window.location`. The one helper
 * that does — getSubredditFromUrl() — is driven by withPath() below, which
 * installs its own location stub.
 */
function withStore(store, fn) {
  const prev = {
    GM_getValue: globalThis.GM_getValue,
    GM_setValue: globalThis.GM_setValue,
  };
  globalThis.GM_getValue = (k, d) => (k in store ? store[k] : d);
  globalThis.GM_setValue = (k, v) => { store[k] = v; };
  try {
    return fn(store);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  }
}

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
  // These drive the real functions against a stubbed GM store. Kept as unit
  // tests because they assert the STORE contract directly (including the
  // malformed-store cases) rather than what a user sees; the e2e suite drives
  // the same behaviour end to end through the served fixture, which is what made
  // `location.pathname` real enough for trackVisit() to run at all.

  const readData = (store) => JSON.parse(store.recentSubreddits || '{"recent":[],"pinned":[]}');
  const readSettings = (store) => JSON.parse(store.recentSubredditsSettings || '{"blocked":[]}');

  test('a visit is recorded', () => {
    const store = {};
    withStore(store, () => trackVisit('webdev'));
    assert.deepEqual(readData(store).recent.map((r) => r.name), ['webdev']);
  });

  test('a blacklisted subreddit is never tracked again', () => {
    // This is the whole point of the blacklist, and it is the behaviour the trash
    // button promises when it says "Remove from history".
    const store = {
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: ['webdev'] }),
    };
    withStore(store, () => trackVisit('webdev'));
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
    withStore(store, () => trackVisit('webdev'));
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
    withStore(store, () => removeVisit('webdev', () => {}));

    assert.deepEqual(readData(store).recent.map((r) => r.name), ['linux'], 'row dropped');
    assert.deepEqual(readSettings(store).blocked, ['webdev'], 'and blacklisted');
  });

  test('removing twice does not duplicate the blacklist entry', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [{ name: 'webdev', visitedAt: 1 }], pinned: [] }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], blocked: ['webdev'] }),
    };
    withStore(store, () => removeVisit('webdev', () => {}));
    assert.deepEqual(readSettings(store).blocked, ['webdev'], 'still one entry');
  });

  test('history is capped at the configured maxRecent', () => {
    // The cap used to be the MAX_RECENT constant; it is a setting now, and this
    // is the path that actually applies it.
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: [] }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], maxRecent: 3 }),
    };
    withStore(store, () => {
      for (const n of ['a', 'b', 'c', 'd', 'e']) trackVisit(n);
    });
    assert.deepEqual(
      readData(store).recent.map((r) => r.name),
      ['e', 'd', 'c'],
      'the newest entries must survive and the rest be dropped'
    );
  });

  test('a pinned subreddit does not count against the cap, and keeps its timestamp', () => {
    // The bug this guards: pinned entries are stored as plain names, and their
    // timestamp is looked up from `recent`. A plain slice would evict the pinned
    // entry's history record, leaving the pinned row on screen with no time
    // while its timestamp silently vanished.
    const store = {
      recentSubreddits: JSON.stringify({
        recent: [
          { name: 'pinned-one', visitedAt: 111 },
          { name: 'fresh', visitedAt: 999 },
          { name: 'old', visitedAt: 1 },
        ],
        pinned: ['pinned-one'],
      }),
      recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], maxRecent: 1 }),
    };
    withStore(store, () => trackVisit('newest'));

    const recent = readData(store).recent;
    assert.deepEqual(
      recent.map((r) => r.name),
      ['newest', 'pinned-one'],
      'one unpinned entry plus the pinned one, which is exempt'
    );
    const kept = recent.find((r) => r.name === 'pinned-one');
    assert.equal(kept.visitedAt, 111, "the pinned entry's timestamp must be preserved");
  });
});

describe('pruneRecent', () => {
  const entries = (names) => names.map((name, i) => ({ name, visitedAt: 1000 - i }));

  test('keeps the newest `maxRecent` unpinned entries, in order', () => {
    const data = { recent: entries(['a', 'b', 'c', 'd']), pinned: [] };
    pruneRecent(data, 2);
    assert.deepEqual(data.recent.map((r) => r.name), ['a', 'b']);
  });

  test('never drops a pinned entry, wherever it sits in the list', () => {
    // Not just the head: a pinned subreddit visited long ago sits at the tail and
    // is exactly the one a plain slice would evict.
    const data = { recent: entries(['a', 'b', 'c', 'pinned']), pinned: ['pinned'] };
    pruneRecent(data, 1);
    assert.deepEqual(data.recent.map((r) => r.name), ['a', 'pinned']);
  });

  test('is a no-op when the list is already within the cap', () => {
    const data = { recent: entries(['a', 'b']), pinned: [] };
    pruneRecent(data, 5);
    assert.deepEqual(data.recent.map((r) => r.name), ['a', 'b']);
  });

  test('a cap larger than the list keeps everything', () => {
    const data = { recent: entries(['a', 'b', 'c']), pinned: ['c'] };
    pruneRecent(data, MAX_MAX_RECENT);
    assert.equal(data.recent.length, 3);
  });
});

describe('movePinned', () => {
  const readPinned = (store) => JSON.parse(store.recentSubreddits).pinned;

  test('moves a pinned subreddit down', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b', 'c'] }),
    };
    let refreshed = null;
    withStore(store, () => movePinned('a', 'down', (d) => { refreshed = d; }));
    assert.deepEqual(readPinned(store), ['b', 'a', 'c']);
    assert.deepEqual(refreshed.pinned, ['b', 'a', 'c'], 'refresh callback gets the new order');
  });

  test('moves a pinned subreddit up', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b', 'c'] }),
    };
    withStore(store, () => movePinned('c', 'up', () => {}));
    assert.deepEqual(readPinned(store), ['a', 'c', 'b']);
  });

  test('no-op when moving up from the first position', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b'] }),
    };
    let called = false;
    withStore(store, () => movePinned('a', 'up', () => { called = true; }));
    assert.deepEqual(readPinned(store), ['a', 'b'], 'order unchanged');
    assert.equal(called, false, 'refresh not called');
  });

  test('no-op when moving down from the last position', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b'] }),
    };
    let called = false;
    withStore(store, () => movePinned('b', 'down', () => { called = true; }));
    assert.deepEqual(readPinned(store), ['a', 'b'], 'order unchanged');
    assert.equal(called, false, 'refresh not called');
  });

  test('no-op for a name that is not pinned', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a'] }),
    };
    let called = false;
    withStore(store, () => movePinned('z', 'down', () => { called = true; }));
    assert.deepEqual(readPinned(store), ['a'], 'order unchanged');
    assert.equal(called, false, 'refresh not called');
  });

  test('works with a single pinned subreddit (both directions no-op)', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['solo'] }),
    };
    withStore(store, () => {
      movePinned('solo', 'up', () => {});
      movePinned('solo', 'down', () => {});
    });
    assert.deepEqual(readPinned(store), ['solo']);
  });

  test('a full reorder sequence produces the expected order', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b', 'c', 'd'] }),
    };
    withStore(store, () => {
      movePinned('a', 'down', () => {}); // b a c d
      movePinned('a', 'down', () => {}); // b c a d
      movePinned('d', 'up', () => {});   // b c d a
      movePinned('b', 'down', () => {}); // c b d a
    });
    assert.deepEqual(readPinned(store), ['c', 'b', 'd', 'a']);
  });
});

describe('togglePin', () => {
  const readPinned = (store) => JSON.parse(store.recentSubreddits).pinned;

  test('pinning adds to the front', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a'] }),
    };
    withStore(store, () => togglePin('b', () => {}));
    assert.deepEqual(readPinned(store), ['b', 'a']);
  });

  test('unpinning removes', () => {
    const store = {
      recentSubreddits: JSON.stringify({ recent: [], pinned: ['a', 'b'] }),
    };
    withStore(store, () => togglePin('a', () => {}));
    assert.deepEqual(readPinned(store), ['b']);
  });
});

describe('checkHarvest', () => {
  // The decision is pure (it takes the harvest's two signals), so every case is
  // unit-testable without a browser. `warnOnce` dedupes per key for the life of
  // the module, so each case needs a fresh import — done with a cache-busting
  // query rather than by exporting a reset, which would be test-only API on the
  // production module.
  async function freshCheckHarvest() {
    const mod = await import(`../../src/diagnostics.js?case=${Math.random()}`);
    return mod.checkHarvest;
  }

  /** Run checkHarvest(signals) against a fresh module and capture the warns. */
  async function runWith(signals) {
    const warns = [];
    const prevWarn = console.warn;
    console.warn = (m) => warns.push(String(m));
    try {
      const check = await freshCheckHarvest();
      check(signals);
      check(signals); // twice: proves the warning does not repeat
    } finally {
      console.warn = prevWarn;
    }
    return warns;
  }

  test('warns when the page names a subreddit but has no icon anchor', async () => {
    // The markup-change signature: the header still says which subreddit this is,
    // but the anchor the harvest reads is gone.
    const warns = await runWith({ named: true, hasIcon: false });
    assert.equal(warns.length, 1, `expected exactly one warning, got ${JSON.stringify(warns)}`);
    assert.match(warns[0], /\[recent-subreddits\]/);
    assert.match(warns[0], /no #subreddit-icon-img anchor/);
    assert.match(warns[0], /grey placeholders/, 'the warning must say what the user will see');
  });

  test('stays silent on a page that names no subreddit', async () => {
    // old.reddit.com (which the script also matches), the home feed, and any
    // non-subreddit route all land here: no header, so nothing to warn about.
    // Without this, the diagnostic would cry wolf on a supported surface.
    assert.deepEqual(await runWith({ named: false, hasIcon: false }), []);
    assert.deepEqual(await runWith({ named: false, hasIcon: true }), []);
  });

  test('stays silent when the anchor is present', async () => {
    // The normal case, including mid-navigation: the anchor is STALE but still
    // there, so the harvest has something to read and the fetch fallback is not
    // being relied on.
    assert.deepEqual(await runWith({ named: true, hasIcon: true }), []);
  });

  test('stays silent when the signals are missing entirely', async () => {
    // Defensive: a caller passing nothing must not warn.
    assert.deepEqual(await runWith(undefined), []);
    assert.deepEqual(await runWith(null), []);
  });
});

describe('the README quotes the real diagnostics', () => {
  // The README drifted once already: it quoted `no popup trigger matched on this
  // page` long after the message became `none of the configured hooks matched`
  // (tech debt #3). A user hitting a broken trigger searches the README for that
  // string and finds nothing. These tie each quoted block to what the code
  // actually prints, so the two cannot separate again — and there are two quoted
  // diagnostics now, so the check is written to cover any number of them.
  const readme = readFileSync(README, 'utf8');

  /**
   * The fenced block whose first line starts with `[recent-subreddits] <starts>`,
   * with its prose line wrapping collapsed to match the one-line message.
   */
  function quotedBlock(starts) {
    // \r?\n because the README is checked out with CRLF on Windows.
    const re = new RegExp('```\\r?\\n(\\[recent-subreddits\\] ' + starts + '[\\s\\S]*?)```');
    const m = readme.match(re);
    assert.ok(m, `the README must quote the "${starts}..." diagnostic in a fenced block`);
    return m[1].replace(/\s+/g, ' ').trim();
  }

  /** Capture what a check function prints, with console.warn stubbed. */
  function captureWarn(fn) {
    const warned = [];
    const prevWarn = console.warn;
    console.warn = (msg) => warned.push(String(msg));
    try {
      fn();
    } finally {
      console.warn = prevWarn;
    }
    return warned;
  }

  test('the message README quotes is the message checkTriggers() prints', () => {
    const prevDoc = globalThis.document;
    // No element matches, so the warning fires.
    globalThis.document = { querySelectorAll: () => [] };
    let warned;
    try {
      warned = captureWarn(() => checkTriggers(['#a', '#b']));
    } finally {
      if (prevDoc === undefined) delete globalThis.document;
      else globalThis.document = prevDoc;
    }

    assert.equal(warned.length, 1, 'a hook matching nothing must warn once');
    // The README shows `...` where the failing selectors go.
    const printed = warned[0].replace('#a, #b', '...');
    assert.equal(quotedBlock('none of the'), printed, 'the README quote must match the code');
  });

  test('the message README quotes is the message checkHarvest() prints', () => {
    // A fresh module, because warnOnce dedupes for the life of the import and the
    // block above already warned under a different key.
    return import(`../../src/diagnostics.js?readme=${Math.random()}`).then(({ checkHarvest }) => {
      const warned = captureWarn(() => checkHarvest({ named: true, hasIcon: false }));
      assert.equal(warned.length, 1, 'a missing anchor on a named page must warn once');
      assert.equal(quotedBlock('this page names'), warned[0], 'the README quote must match the code');
    });
  });

  test('the README no longer quotes the superseded message', () => {
    // The specific regression: the old wording, which no longer exists anywhere
    // in src/.
    assert.doesNotMatch(
      readme,
      /no popup trigger matched on this page/,
      'the README still quotes the pre-settings-panel wording'
    );
  });
});

describe('the built-in trigger as a default setting', () => {
  test('the defaults carry the built-in hook, so a first run works', () => {
    // The trigger used to be a hardcoded fallback in the resolver. It has to be
    // in the defaults instead, or a fresh install would have hover disabled.
    assert.equal(DEFAULT_SETTINGS.targets.length, 1, 'the defaults must include one target');
    // Selected by what it is, not by where it sits: a positional pick would keep
    // passing if the defaults gained another target in front of this one.
    const t = DEFAULT_SETTINGS.targets.find((x) => /top-nav-logo/.test(x.selector));
    assert.ok(t, 'the built-in selector must be among the defaults');
    assert.equal(t.mode, 'hook');
    assert.equal(t.events, 'both');
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

  test('hideRowControls is opt-in, and a malformed value falls back to off', () => {
    // Off by default: the list must not change appearance for anyone who has
    // not asked for it.
    assert.equal(DEFAULT_SETTINGS.hideRowControls, false, 'the option must default to off');
    assert.equal(defaultSettings().hideRowControls, false, 'and reset must restore off');

    const cases = [
      ['absent', { hotkey: 'Alt+Shift+R', targets: [] }],
      ['a string "true"', { hotkey: 'Alt+Shift+R', targets: [], hideRowControls: 'true' }],
      ['null', { hotkey: 'Alt+Shift+R', targets: [], hideRowControls: null }],
    ];
    for (const [label, stored] of cases) {
      const store = { recentSubredditsSettings: JSON.stringify(stored) };
      const s = withStore(store, () => loadSettings());
      assert.equal(s.hideRowControls, false, `${label} must resolve to off`);
    }

    const on = { recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], hideRowControls: true }) };
    assert.equal(withStore(on, () => loadSettings()).hideRowControls, true, 'an explicit true must be kept');
  });

  test('showTimestamps is opt-out, and a malformed value falls back to on', () => {
    // On by default: timestamps are useful unless the user explicitly hides them.
    assert.equal(DEFAULT_SETTINGS.showTimestamps, true, 'the option must default to on');
    assert.equal(defaultSettings().showTimestamps, true, 'and reset must restore on');

    const cases = [
      ['absent', { hotkey: 'Alt+Shift+R', targets: [] }],
      ['a string "false"', { hotkey: 'Alt+Shift+R', targets: [], showTimestamps: 'false' }],
      ['null', { hotkey: 'Alt+Shift+R', targets: [], showTimestamps: null }],
    ];
    for (const [label, stored] of cases) {
      const store = { recentSubredditsSettings: JSON.stringify(stored) };
      const s = withStore(store, () => loadSettings());
      assert.equal(s.showTimestamps, true, `${label} must resolve to on`);
    }

    const off = { recentSubredditsSettings: JSON.stringify({ hotkey: 'Alt+Shift+R', targets: [], showTimestamps: false }) };
    assert.equal(withStore(off, () => loadSettings()).showTimestamps, false, 'an explicit false must be kept');
  });

  test('maxRecent is clamped to a sane range, and junk falls back to the default', () => {
    assert.equal(DEFAULT_SETTINGS.maxRecent, 15, 'the default must match the old constant');
    assert.equal(defaultSettings().maxRecent, 15, 'and reset must restore it');

    const cases = [
      ['absent', { hotkey: 'Alt+Shift+R', targets: [] }, 15],
      ['a non-numeric string', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: 'lots' }, 15],
      ['null', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: null }, 15],
      ['an empty string', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: '' }, 15],
      ['0', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: 0 }, MIN_MAX_RECENT],
      ['a negative', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: -5 }, MIN_MAX_RECENT],
      ['absurdly large', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: 1e6 }, MAX_MAX_RECENT],
      ['a numeric string', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: '8' }, 8],
      ['a float', { hotkey: 'Alt+Shift+R', targets: [], maxRecent: 7.9 }, 7],
    ];
    for (const [label, stored, expected] of cases) {
      const store = { recentSubredditsSettings: JSON.stringify(stored) };
      assert.equal(
        withStore(store, () => loadSettings()).maxRecent,
        expected,
        `${label} must resolve to ${expected}`
      );
    }
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
