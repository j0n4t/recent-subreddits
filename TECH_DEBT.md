# Technical debt

Known gaps and the reasoning behind each, ordered by what I would do first. This
is a working list, not a roadmap: an item is done when it is deleted from here,
and anything measured says what was measured.

The repo is local-only for now. Anything that only pays off with a remote (CI) is
listed under "When this goes online" at the end rather than in the priority order
— until then, `npm run check` before a commit is the gate.

Priorities are **1 = do next**. Each entry says why it matters and how to tell it
is fixed.

---

## 1. A harvest failure is silent

**Why it matters.** `checkTriggers()` warns when configured hooks match nothing,
which makes a Reddit markup change visible. The harvest has the same failure
shape and no such warning: if `#subreddit-icon-img` is renamed, harvesting stops
and every icon falls back to the rate-limited fetch. The user sees grey icons —
the exact bug this repo already fixed once — with nothing in the console.

**Fix.** A `checkHarvest()` warning following the existing pattern.

**Done when.** Breaking the harvest on the fixture produces a console warning.

---

## 2. `escAttr` lives in `icons.js`

**Why it matters.** It is a generic HTML-escaping helper defined in the icon
module and imported by `content.js` and `settings-panel.js` for unrelated
reasons. The module's stated purpose ("subreddit icon cache and fetch") is then
false, and a reader editing icon logic meets an HTML helper they did not expect.

**Fix.** Move it to a leaf module (`html.js` or `dom.js`).

**Done when.** No module imports an escaping helper from an unrelated feature.

---

## 3. The injected stylesheet is never validated

**Why it matters.** `injectStyles()` builds one large CSS string. A typo — a
missing brace, a misspelled property — fails silently at runtime, and nothing
catches it: there is no stylelint, and the two tests touching `#rs-styles` assert
only that the element exists, not that the CSS parsed.

**Fix.** Assert that `document.styleSheets` contains a rule for a known selector
after injection. Cheap and it closes a whole failure class.

**Done when.** A deliberately broken CSS rule fails a test.

---

## 4. Keyboard navigation in the popup

**Why it matters.** The hotkey exists so the popup works regardless of Reddit's
markup; once it is open, the list is mouse-only. Arrow keys to move, Enter to
open, Delete to remove the highlighted row would complete the path and reuse the
existing trash/blocklist logic.

**Done when.** The popup is fully usable without a pointer.

---

## 5. Import / export settings

**Why it matters.** Settings are now a real user-authored model — hotkey, page
targets with selectors and modes, and a blocklist. Losing them to a Tampermonkey
reinstall is avoidable, and because the picker builds durable selectors, a shared
configuration is meaningful.

**Done when.** Settings can be exported to JSON and imported back.

---

## 6. An inline target that matches nothing is silent

**Why it matters.** `applyTargets()` mounts nothing for an unmatched selector,
deliberately and with a test asserting the silence. A one-line diagnostic naming
the target would save the user guessing why their block never appeared.

**Done when.** A configured target matching nothing is reported once per page.

---

## When this goes online

Not worth doing while the repo is local; worth doing the moment it has a remote,
roughly in this order.

- **CI running `npm run check`.** The suite is the strongest thing here and
  nothing runs it automatically. `findBrowser()` already skips cleanly with no
  browser present, and the harness documents the Playwright cache location, so
  e2e can run in CI rather than being skipped.
- **The artifact-freshness gate in CI too**, so a pull request cannot merge a
  stale build. `npm run verify` covers this locally; CI makes it enforceable.
- **`.gitattributes` matters more** once anyone else clones — the CRLF churn
  becomes their problem too.
- **Check a `LICENSE` file exists.** The README says MIT; confirm the file is
  really there before the repo is public.

---

## Considered and deliberately not done

- **A formatter (prettier).** The codebase is already consistent: 16 of 17
  modules are single-quote dominant, and the one that is not is `content.js`,
  which builds HTML strings where double quotes inside the string are the natural
  choice. Adding one now would produce a large reformat diff and fight the HTML
  template literals. Targeted lint rules are the better lever if this changes.
- **Splitting modules for size.** The largest is `styles.js` at 584 lines, of
  which 573 are CSS, already sectioned by concern. `app.js` is next at 477 (344
  code). Nothing here is too big to hold in your head; splitting would add
  indirection for no gain.
- **Splitting the e2e test file.** It is 3020 lines, but a flat list of 95 tests
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
  unreliable precisely when it mattered. Item 1 (a harvest diagnostic) is the
  better answer: it reports the drift at runtime, in the console, instead of
  waiting for someone to remember to run a script.
