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
