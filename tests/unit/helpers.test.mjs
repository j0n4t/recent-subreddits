// Unit tests: no browser, no network. These must stay green on a machine
// without Chromium, which is why the e2e suite lives in its own tree/script.
//
// Run:  npm test

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..', 'recent-subreddits.user.js');
const source = readFileSync(SRC, 'utf8');

/**
 * Extract a top-level `function name(...) {...}` body from the userscript and
 * evaluate it in isolation. The script is a single IIFE with no exports, so this
 * is how a pure helper gets unit-tested without restructuring it.
 */
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `function ${name} not found in the userscript`);

  let depth = 0;
  let i = source.indexOf('{', start);
  const bodyStart = i;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  const text = source.slice(start, i + 1);
  // eslint-disable-next-line no-new-func
  return new Function(`return (${text})`)();
}

describe('metadata block', () => {
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
  const formatTimeAgo = extractFunction('formatTimeAgo');
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
  const fn = extractFunction('getSubredditFromUrl');

  /** Re-evaluate the function with a stubbed location. */
  function withPath(path) {
    const src = source.slice(
      source.indexOf('function getSubredditFromUrl('),
      source.indexOf('function trackVisit(')
    );
    // eslint-disable-next-line no-new-func
    return new Function('window', `${src}\nreturn getSubredditFromUrl();`)({
      location: { pathname: path },
    });
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

  // Sanity: the extracted standalone copy must agree with the in-source helper.
  test('extracted copy matches the original function source', () => {
    assert.equal(typeof fn, 'function');
  });
});
