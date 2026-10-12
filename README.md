# Recent Subreddits Sidebar

A Tampermonkey userscript that lists your recently visited subreddits in a popup
anchored to Reddit's logo, with the ability to pin favorites for quick access.

## Features

- Automatically tracks subreddits you visit (up to 15 recent)
- Popup opens on hover or click of the Reddit logo / menu button, positioned
  relative to whichever element triggered it (flips above when there is no room below)
- Shows each subreddit's community icon
- Pin/unpin subreddits to keep them at the top
- Relative timestamps (e.g. "5m ago", "2h ago")
- Light and dark mode
- Works on both new Reddit (www) and old Reddit
- Handles Reddit's single-page navigation — no page reload needed
- Data persists across sessions via Tampermonkey storage

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Click the Tampermonkey icon → **Create a new script**
3. Delete the template code and paste the contents of `recent-subreddits.user.js`
4. Save (`Ctrl+S` / `Cmd+S`)
5. Visit any subreddit on Reddit — then hover the Reddit logo

## Usage

- **Hover** the Reddit logo (or menu button) to open the popup; **click** it to toggle
- **Pinned section**: subreddits you've pinned, always at the top
- **Recent section**: subreddits you've visited, most recent first
- **Pin button** (📌): Click to pin a subreddit — it moves to the Pinned section
- **Unpin button** (✕): Click to unpin — it returns to the Recent section
- Click any subreddit name to navigate to it
- Dismiss with the close button, a click outside, or `Escape`

## Files

| File | Description |
|------|-------------|
| `recent-subreddits.user.js` | The userscript |
| `tests/unit/` | Fast unit tests (no browser) |
| `tests/e2e/` | Browser regression tests over CDP |
| `tests/fixtures/reddit-mock.html` | Local Reddit stand-in that stubs the `GM_*` APIs |
| `README.md` | This file |

## Development

No dependencies to install — the tests use Node's built-in test runner and
WebSocket, and drive a real Chromium over the DevTools Protocol.

```bash
npm test         # unit tests only (no browser needed)
npm run test:e2e # browser regression tests
npm run test:all # both
```

The e2e suite loads the real userscript into `tests/fixtures/reddit-mock.html`,
which mimics the Reddit markup the script anchors to and stubs `GM_getValue`,
`GM_setValue` and `GM_xmlhttpRequest`. **It never contacts reddit.com**, so bot
protection and rate limits are not a factor; the icon data comes from the stub.

A Chromium is located automatically (Playwright's cache, then Chrome, then Edge).
Set `E2E_BROWSER` to point at a specific binary. **If no browser is found the e2e
suite skips rather than fails**, so `npm test` stays usable on a machine without one.

## Compatibility

- Chrome / Edge / Firefox / Safari (with Tampermonkey installed)
- Reddit new UI and old UI (`old.reddit.com`)

## License

MIT
