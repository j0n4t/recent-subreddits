# Technical debt

Known gaps and the reasoning behind each, ordered by what I would do first. This
is a working list, not a roadmap: an item is done when it is deleted from here,
and anything measured should say what was measured.

Priorities are **1 = do next**. Each entry says why it matters and how to tell it
is fixed.

---

## 1. Line endings are not pinned (`.gitattributes`)

**Why it matters.** The working copy is CRLF while the source is written LF, so
git rewrites line endings on every commit (`LF will be replaced by CRLF` on every
build and commit) and tooling that matches text anchors — targeted edits, patches
— fails on multi-line matches for no visible reason. This has cost real time
repeatedly, and it will keep doing so.

**Fix.** Add `.gitattributes` with `* text=auto eol=lf`.

**Done when.** `git status` after a build is clean and no CRLF warnings appear on
commit.

---

## 2. Nothing runs the suite automatically (no CI)

**Why it matters.** The suite is the strongest thing in this repo — 25 unit and
61 e2e tests, with a CDP harness that needs no puppeteer/playwright dependency —
but it only runs when someone remembers to run it. Nothing stops a regression
from being committed.

**Fix.** A workflow running `npm run check` on push. `findBrowser()` already
skips cleanly when no browser is present, and the harness documents the
Playwright cache location, so e2e can run in CI rather than being skipped.

**Done when.** A pull request cannot merge with a red suite.

---

## 3. A stale committed artifact is not caught

**Why it matters.** `recent-subreddits.user.js` is a build output that is
committed, because it is the file users paste into Tampermonkey. It was touched
in 6 of the last 8 commits. `pretest` rebuilds, so tests always run against fresh
output — which means a *stale committed artifact* passes every test while being
wrong for the user who installs it.

**Fix.** The build is deterministic (verified: rebuilding an unchanged tree
produces no diff), so `npm run build && git diff --exit-code` is an exact gate.

**Done when.** CI fails when the committed artifact does not match `src/`.

---

## 4. The built-in selector is duplicated across four files

**Why it matters.** `TRIGGER_SELECTOR` is hand-copied into `tests/e2e/sidebar.test.mjs`,
`tests/fixtures/reddit-mock.html` and `tests/unit/helpers.test.mjs`. A change to
the real selector silently leaves the tests asserting the old one — the tests
would keep passing while testing nothing real.

**Fix.** The tests are ESM, so they can import `BUILTIN_HOOK` from `src/defaults.js`
directly. The fixture cannot (it is a plain page), so keep one copy there plus a
test asserting the fixture's copy equals the source.

**Done when.** `grep -r navbar-menu-button` finds one definition plus one
deliberate fixture copy, with a test tying them together.

---

## 5. The measurements this design rests on are not preserved

**Why it matters.** Several decisions depend on facts measured against the live
site, and those facts are not written down anywhere durable:

- Reddit answers `/r/<name>/about.json` with a 403 plus an HTML body, per
  subreddit and time-varying (measured: two of twelve subreddits 403'd on every
  attempt while their neighbours succeeded).
- `#subreddit-icon-img` holds the current subreddit's icon, and is present
  immediately on load.
- After a subreddit-to-subreddit navigation that anchor keeps the *previous*
  subreddit's icon for roughly a second.
- `shreddit-subreddit-header[name]` names the subreddit the page is displaying.

The probes that produced these were throwaway scripts. If Reddit changes, the
claims cannot be re-verified without rewriting them.

**Fix.** Promote the handful of probes that produced load-bearing numbers into
`scripts/probes/`, each with the finding in a comment at the top.

**Done when.** The claims above can be re-checked by running one command.

---

## 6. README has drifted from the code

**Why it matters.** Two concrete regressions:

- README quotes the diagnostic as `no popup trigger matched on this page`; the
  message is now `none of the configured hooks matched on this page`, because the
  built-in trigger became an editable settings entry.
- The trash button, the blocklist, and its settings textarea are undocumented.

**Fix.** Update both, and consider a test asserting the string the README quotes
appears in `src/`.

**Done when.** Every user-visible behaviour is described, and quoted strings match.

---

## 7. The e2e fixture is a `file://` page, so URL-dependent code is untestable

**Why it matters.** Because the fixture has no `/r/<name>/` path, `trackVisit()`
never runs in e2e — the "a blacklisted subreddit is never tracked again" test had
to move to the unit suite. The harvest's SPA staleness window is also simulated
with a `?subStale=` flag rather than a real navigation. Both are the code most
likely to break silently on a Reddit change.

**Fix.** Serve the fixture over a tiny static server in `cdp-harness.mjs` so
`location.pathname` is real.

**Done when.** Tracking and the harvest can be driven through a real navigation
in e2e.

---

## 8. A harvest failure is silent

**Why it matters.** `checkTriggers()` warns when configured hooks match nothing,
which makes a Reddit markup change visible. The harvest has the same failure
shape and no such warning: if `#subreddit-icon-img` is renamed, harvesting stops
and every icon falls back to the rate-limited fetch. The user sees grey icons —
the exact bug this repo already fixed once — with nothing in the console.

**Fix.** A `checkHarvest()` warning following the existing pattern.

**Done when.** Breaking the harvest on the fixture produces a console warning.

---

## 9. `escAttr` lives in `icons.js`

**Why it matters.** It is a generic HTML-escaping helper defined in the icon
module and imported by `content.js` and `settings-panel.js` for unrelated
reasons. The module's stated purpose ("subreddit icon cache and fetch") is then
false, and a reader editing icon logic meets an HTML helper they did not expect.

**Fix.** Move it to a leaf module (`html.js` or `dom.js`).

**Done when.** No module imports an escaping helper from an unrelated feature.

---

## 10. The injected stylesheet is never validated

**Why it matters.** `injectStyles()` builds one large CSS string. A typo — a
missing brace, a misspelled property — fails silently at runtime, and nothing
catches it: there is no stylelint, and the two tests touching `#rs-styles` assert
only that the element exists, not that the CSS parsed.

**Fix.** Assert that `document.styleSheets` contains a rule for a known selector
after injection. Cheap and it closes a whole failure class.

**Done when.** A deliberately broken CSS rule fails a test.

---

## 11. Keyboard navigation in the popup

**Why it matters.** The hotkey exists so the popup works regardless of Reddit's
markup; once it is open, the list is mouse-only. Arrow keys to move, Enter to
open, Delete to remove the highlighted row would complete the path and reuse the
existing trash/blocklist logic.

**Done when.** The popup is fully usable without a pointer.

---

## 12. Import / export settings

**Why it matters.** Settings are now a real user-authored model — hotkey, page
targets with selectors and modes, and a blocklist. Losing them to a Tampermonkey
reinstall is avoidable, and because the picker builds durable selectors, a shared
configuration is meaningful.

**Done when.** Settings can be exported to JSON and imported back.

---

## 13. Relative timestamps freeze while the popup is open

**Why it matters.** `formatTimeAgo` runs at render only, so an open popup keeps
showing "just now" indefinitely.

**Done when.** An open popup's timestamps age.

---

## 14. An inline target that matches nothing is silent

**Why it matters.** `applyTargets()` mounts nothing for an unmatched selector,
deliberately and with a test asserting the silence. A one-line diagnostic naming
the target would save the user guessing why their block never appeared.

**Done when.** A configured target matching nothing is reported once per page.

---

## Considered and deliberately not done

- **A formatter (prettier).** The codebase is already consistent: 13 of 15
  modules are single-quote dominant, and the two that are not are the two that
  build HTML strings, where double quotes inside the string are the natural
  choice. Adding one now would produce a large reformat diff and fight the HTML
  template literals. Targeted lint rules are the better lever if this changes.
- **Splitting modules for size.** The largest is `styles.js` at 472 lines, of
  which 435 are CSS, already sectioned by concern. Nothing here is too big to
  hold in your head; splitting would add indirection for no gain.
- **Typechecking `tests/`.** `tsconfig.json` covers `src` only, but most test
  bodies are `b.evaluate(\`...\`)` strings that a typechecker cannot see into.
- **Multiple settings profiles.** The target model would support it, but nothing
  suggests the complexity is wanted.
