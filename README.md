# Recent Subreddits Sidebar

A Tampermonkey userscript that adds a sidebar to Reddit listing your recently visited subreddits, with the ability to pin favorites for quick access.

## Features

- Automatically tracks subreddits you visit (up to 15 recent)
- Pin/unpin subreddits to keep them at the top
- Relative timestamps (e.g. "5m ago", "2h ago")
- Works on both new Reddit (www) and old Reddit
- Handles Reddit's single-page navigation — no page reload needed
- Data persists across sessions via Tampermonkey storage

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension
2. Click the Tampermonkey icon → **Create a new script**
3. Delete the template code and paste the contents of `recent-subreddits.user.js`
4. Save (`Ctrl+S` / `Cmd+S`)
5. Visit any subreddit on Reddit — the sidebar will appear

## Usage

- **Recent section**: Shows subreddits you've visited, most recent first
- **Pin button** (📌): Click to pin a subreddit — it moves to the Pinned section
- **Unpin button** (✕): Click to unpin — it returns to the Recent section
- Click any subreddit name to navigate to it

## Files

| File | Description |
|------|-------------|
| `recent-subreddits.user.js` | The userscript |
| `README.md` | This file |

## Compatibility

- Chrome / Edge / Firefox / Safari (with Tampermonkey installed)
- Reddit new UI and old UI (`old.reddit.com`)

## License

MIT
