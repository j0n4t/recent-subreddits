# Technical debt

Known gaps and the reasoning behind each, ordered by what I would do first. This
is a working list, not a roadmap: an item is done when it is deleted from here,
and anything measured says what was measured.

The repo has a remote now, and CI (`.github/workflows/ci.yml`) runs `npm run
check` plus the artifact-freshness gate on every push to `main` and every pull
request, so the gate is enforced rather than remembered. Running `npm run check`
before a commit still keeps the feedback loop local.

Priorities are **1 = do next**. Each entry says why it matters and how to tell it
is fixed.

---

## 1. Keyboard navigation in the popup

**Why it matters.** The hotkey exists so the popup works regardless of Reddit's
markup; once it is open, the list is mouse-only. Arrow keys to move, Enter to
open, Delete to remove the highlighted row would complete the path and reuse the
existing trash/blocklist logic.

**Done when.** The popup is fully usable without a pointer.

---

## 2. Import / export settings

**Why it matters.** Settings are now a real user-authored model — hotkey, page
targets with selectors and modes, and a blocklist. Losing them to a Tampermonkey
reinstall is avoidable, and because the picker builds durable selectors, a shared
configuration is meaningful.

**Done when.** Settings can be exported to JSON and imported back.

---

## Considered and deliberately not done

- **A formatter (prettier).** The codebase is already consistent: 16 of 17
  modules are single-quote dominant, and the one that is not is `content.js`,
  which builds HTML strings where double quotes inside the string are the natural
  choice. Adding one now would produce a large reformat diff and fight the HTML
  template literals. Targeted lint rules are the better lever if this changes.
- **Splitting modules for size.** The largest is `styles.js` at 584 lines, of
  which 573 are the CSS template literal (lines 10–582), already sectioned by
  concern. `app.js` is next at 483, of which 296 are code (non-blank,
  non-comment). Nothing here is too big to hold in your head; splitting would add
  indirection for no gain.
- **Splitting the e2e test file.** It is 3132 lines, but a flat list of 100 tests
  that greps cleanly. Splitting it would scatter the shared fixture and helpers
  for no gain — the run() migration and the openPopup/openSettings helpers were
  the fixes that actually reduced the weight.
- **Typechecking `tests/`.** `tsconfig.json` covers `src` only. The test logic is
  no longer embedded strings — run() made it real functions — so extending the
  tsconfig here is now worth reconsidering rather than blocked; nothing has been
  measured either way yet.
- **Multiple settings profiles.** The target model would support it, but nothing
  suggests the complexity is wanted.
- **Promoting the live-site probes into `scripts/probes/`.** The measurements
  this design rests on are recorded where they are used: the 403 behaviour and
  the `#subreddit-icon-img` harvest both have their numbers in the `src/icons.js`
  header, next to the decisions they justify, and the decisions themselves are
  pinned by fixture tests (the 403 retry, the harvest, and the mid-navigation
  staleness window, which a real navigation now drives). What a probe directory
  would add is re-checkability against live Reddit — but that is exactly the
  flaky, rate-limited surface the measurements describe, so the check would be
  unreliable precisely when it mattered. The harvest diagnostic (done) is the
  better answer: it reports the drift at runtime, in the console, instead of
  waiting for someone to remember to run a script.
