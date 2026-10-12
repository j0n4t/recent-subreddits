// Zero-dependency browser harness over CDP.
//
// Node's built-in WebSocket (Node 22+) speaks CDP directly, so no puppeteer or
// playwright package is needed. The suite drives a local fixture page that stubs
// the GM_* APIs and loads the REAL userscript, so nothing here talks to reddit.com
// and bot protection is never in the picture.
//
// Only the e2e test file should import this. Importing it from a unit test would
// reintroduce the browser dependency the unit/e2e split exists to avoid.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ask the OS for a free port, then release it.
 *
 * Do NOT derive the port from the pid: on Windows, Hyper-V/WSL reserve whole TCP
 * ranges (check `netsh interface ipv4 show excludedportrange protocol=tcp`), and
 * Chromium then dies with `bind() ... 0x271D` / "Cannot start http server for
 * devtools" — which surfaces as "browser never exposed a CDP socket". An
 * ephemeral port is never allocated from a reserved range.
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Probe known Chromium locations; an env override wins. Returns null if none. */
export function findBrowser() {
  // An explicit override is authoritative: if it is set but wrong, that is a
  // configuration error the user should see, not something to silently paper over
  // by falling back to another browser.
  if (process.env.E2E_BROWSER) {
    return existsSync(process.env.E2E_BROWSER) ? process.env.E2E_BROWSER : null;
  }

  const candidates = [
    join(process.env.LOCALAPPDATA || '', 'ms-playwright'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);

  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (c.endsWith('ms-playwright')) {
      // Versioned cache dir: pick the newest chromium-*/chrome-win64/chrome.exe
      let best = null;
      try {
        for (const entry of readdirSync(c)) {
          if (!entry.startsWith('chromium-')) continue;
          const exe = join(c, entry, 'chrome-win64', 'chrome.exe');
          if (existsSync(exe)) best = exe;
        }
      } catch { /* ignore */ }
      if (best) return best;
      continue;
    }
    return c;
  }
  return null;
}

export class Browser {
  constructor(proc, ws, userDataDir, cdpPort) {
    this.proc = proc;
    this.ws = ws;
    this.userDataDir = userDataDir;
    this.cdpPort = cdpPort;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.sessionId = null;
    this.loadWaiter = null;
    // Set by launch(): true when the profile must outlive this process.
    this.keepProfile = false;
  }

  /**
   * Launch a browser.
   *
   * `headful` shows a real window (for the manual suite, where a person drives
   * the interactions). `userDataDir` reuses a profile across runs — the manual
   * suite points it at a persistent dir so Reddit's JS challenge is cleared
   * once and stays cleared. Defaults keep the automated suite exactly as it
   * was: headless, throwaway profile, deleted on stop().
   */
  static async launch({ headful = false, userDataDir = null, keepProfile = false } = {}) {
    const browserPath = findBrowser();
    if (!browserPath) return null;

    const cdpPort = await findFreePort();
    const ownProfile = !userDataDir;
    const profile = userDataDir || mkdtempSync(join(tmpdir(), 'rs-e2e-chrome-'));

    const proc = spawn(
      browserPath,
      [
        ...(headful ? ['--start-maximized'] : ['--headless=new', '--disable-gpu']),
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--allow-file-access-from-files',
        // A Playwright-downloaded Chromium cannot access its own binary from the
        // Windows sandbox ("Sandbox cannot access executable ... Acesso negado"),
        // so it never starts. Harmless for a local, throwaway-profile test browser.
        '--no-sandbox',
        '--disable-dev-shm-usage',
        `--user-data-dir=${profile}`,
        `--remote-debugging-port=${cdpPort}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    // Capture stderr so a launch failure reports the real reason instead of a
    // bare timeout — this is what distinguishes "no socket yet" from "died".
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    // Discover the socket by polling /json/version, not by parsing stderr.
    let wsUrl = null;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (proc.exitCode !== null) break; // died; no point polling on
      try {
        const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        wsUrl = (await res.json()).webSocketDebuggerUrl;
        if (wsUrl) break;
      } catch { /* not up yet */ }
      await delay(100);
    }
    if (!wsUrl) {
      proc.kill();
      // Clean up the profile we just made: launch() is throwing, so stop() will
      // never run and the temp dir would leak for every failed launch.
      try { rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 }); }
      catch { /* ignore */ }
      throw new Error(
        `browser never exposed a CDP socket on port ${cdpPort}` +
          (proc.exitCode !== null ? ` (exited with code ${proc.exitCode})` : '') +
          (stderr ? `\n--- browser stderr ---\n${stderr.slice(0, 2000)}` : '')
      );
    }

    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });

    const b = new Browser(proc, ws, profile, cdpPort);
    b.keepProfile = keepProfile || !ownProfile;

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = b.pending.get(msg.id);
        if (!p) return;
        b.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else p.resolve(msg.result);
        return;
      }
      // Route events to per-method listeners, filtered to our session.
      const list = b.listeners.get(msg.method);
      if (!list) return;
      for (const fn of list) {
        if (msg.sessionId && b.sessionId && msg.sessionId !== b.sessionId) continue;
        fn(msg.params || {});
      }
    });

    await b.attachPage();
    return b;
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      const frame = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      this.ws.send(JSON.stringify(frame));
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(fn);
  }

  // The browser-level socket has no Page domain: create a page, attach flattened,
  // and send page commands on the returned sessionId.
  async attachPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = sessionId;

    this.on('Page.loadEventFired', () => {
      if (this.loadWaiter) {
        const { resolve } = this.loadWaiter;
        this.loadWaiter = null;
        resolve();
      }
    });

    await this.session('Page.enable');
    await this.session('Runtime.enable');
    return sessionId;
  }

  session(method, params = {}) {
    return this.send(method, params, this.sessionId);
  }

  /** Navigate and wait for load, with a cap so a dead navigation cannot hang. */
  async goto(url, timeoutMs = 20000) {
    const loaded = new Promise((resolve) => { this.loadWaiter = { resolve }; });
    await this.session('Page.navigate', { url });
    await Promise.race([loaded, delay(timeoutMs)]);
  }

  /** Evaluate in the page. Throws on exceptionDetails so a throwing expression
   *  is not mistaken for "the app did not update". */
  async evaluate(expression) {
    const res = await this.session('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      const desc = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`page JS threw: ${desc}\n--- expression ---\n${expression}`);
    }
    return res.result.value;
  }

  /** Poll an expression until truthy; the label names what never happened. */
  async waitUntil(expression, label, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(expression);
      if (last) return last;
      await delay(100);
    }
    throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
  }

  async stop() {
    try { await this.send('Browser.close'); } catch { /* already gone */ }
    await delay(300);
    if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill();

    // Wait for the process to actually exit before touching its profile:
    // Browser.close returns immediately, and Windows keeps every handle in the
    // profile locked until the process is really gone, so an immediate rmSync
    // silently leaves the directory behind.
    const deadline = Date.now() + 8000;
    while (this.proc.exitCode === null && this.proc.signalCode === null && Date.now() < deadline) {
      await delay(150);
    }

    // Never delete a profile we did not create: the manual suite reuses one so
    // a cleared Reddit challenge survives between runs.
    if (this.keepProfile) return;
    this.removeProfile();
  }

  /** Remove a throwaway profile, retrying while Windows releases its handles. */
  removeProfile() {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        rmSync(this.userDataDir, { recursive: true, force: true, maxRetries: 2 });
        return;
      } catch {
        // Held briefly; the next attempt usually wins.
      }
    }
    // A leaked profile must not fail an otherwise green run, but say so rather
    // than hiding it — otherwise temp dirs accumulate unnoticed.
    console.warn(`[e2e] could not remove the profile at ${this.userDataDir}`);
  }
}
