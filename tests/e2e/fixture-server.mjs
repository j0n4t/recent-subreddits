// A tiny static server for the e2e fixture, so the page has a REAL origin.
//
// Why this exists (tech debt #4): the fixture used to be opened as a `file://`
// page, which has two consequences that made the most fragile code untestable:
//
//   * `location.pathname` is a filesystem path, never `/r/<name>/`, so
//     `trackVisit()` never ran — the visit-tracking and cap tests had to live in
//     the unit suite instead of being driven through the real userscript.
//   * `history.pushState` THROWS on a `file://` document, so Reddit's SPA
//     navigation could not be reproduced at all. The harvest's staleness window
//     had to be faked with a flag, which asserts the DOM state but never
//     exercises the navigation observer that reacts to it.
//
// Routing is deliberately total: every path serves the fixture, because Reddit
// serves its SPA shell for every route and the tests need arbitrary paths like
// `/r/javascript/` to be real without maintaining a route table. The built
// userscript is the one exception, matched by filename so the fixture's absolute
// `<script src>` resolves from any route depth.

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', 'reddit-mock.html');
const USERSCRIPT = join(HERE, '..', '..', 'recent-subreddits.user.js');
const USERSCRIPT_NAME = 'recent-subreddits.user.js';

/**
 * Start the fixture server on an ephemeral port.
 *
 * Port 0 rather than a fixed one: on Windows, Hyper-V/WSL reserve whole TCP
 * ranges (see findFreePort() in cdp-harness.mjs), and a hardcoded port fails
 * with `bind() ... 0x271D`.
 *
 * Returns `{ origin, close }` — `origin` is the base URL with no trailing slash,
 * so callers build `${origin}/r/<name>/?...`.
 */
export async function startFixtureServer() {
  const server = createServer((req, res) => {
    // Ignore the query string for routing: it carries the test's seed data.
    const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

    // Read per request rather than once at startup: `npm test` rebuilds the
    // userscript first (pretest), but the manual suite may run against a build
    // made after this process started, and serving a stale copy would silently
    // test the wrong code.
    let body;
    let type;
    if (path.endsWith('/' + USERSCRIPT_NAME)) {
      body = readFileSync(USERSCRIPT);
      type = 'text/javascript; charset=utf-8';
    } else {
      body = readFileSync(FIXTURE);
      type = 'text/html; charset=utf-8';
    }

    res.writeHead(200, {
      'Content-Type': type,
      // The fixture is regenerated between runs; a cached copy would make a test
      // pass against an old page.
      'Cache-Control': 'no-store',
    });
    res.end(body);
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
