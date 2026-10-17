// Settings panel
//
// The settings view: hotkey capture and the page-target list. It renders into
// whichever instance opened it (the popup or an inline block), so the instance
// and a small controller surface are passed in rather than closed over — that
// keeps this module free of an import cycle with the mount code.
import { loadSettings, saveSettings, defaultSettings, DEFAULT_SETTINGS, MIN_MAX_RECENT, MAX_MAX_RECENT, clampMaxRecent, pruneRecent, loadData, saveData } from './storage.js';
import { escAttr } from './icons.js';
import { parseHotkey, comboFromEvent } from './hotkey.js';
import { startPicker } from './picker.js';

/**
 * Render the settings panel body into one instance's settings slot.
 * `instance` defaults to the popup; an inline target passes its own node.
 */
export function renderSettingsPanel(instance, ctl, openSection) {
  const host = instance;
  if (!host) return;
  const panel = host.querySelector('.rs-settings-panel');
  if (!panel) return;

  const settings = loadSettings();

  // A hook is what opens the popup by hover/click. With none configured the
  // popup is only reachable by hotkey, so the panel says so rather than leaving
  // the user with a list that silently no longer opens anything.
  const hasHook = settings.targets.some((t) => t.mode === 'hook');

  const modeOptions = (selected) =>
    [
      ['hook', 'Hook (open popup)'],
      ['replace', 'Replace element'],
      ['prepend', 'Prepend inside'],
      ['append', 'Append inside'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
      )
      .join('');

  const eventOptions = (selected) =>
    [
      ['both', 'Hover + click'],
      ['hover', 'Hover only'],
      ['click', 'Click only'],
    ]
      .map(
        ([value, label]) =>
          `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`
      )
      .join('');

  const targetRows = settings.targets.length
    ? settings.targets
      .map((t, i) => {
        // Events only mean something for a hook target.
        const eventsCell =
          t.mode === 'hook'
            ? `<select class="rs-select" data-role="events" data-index="${i}">${eventOptions(t.events)}</select>`
            : `<span class="rs-muted">—</span>`;
        return `
            <li class="rs-target">
              <code class="rs-target-sel" title="${escAttr(t.selector)}">${escAttr(t.selector)}</code>
              <div class="rs-target-controls">
                <select class="rs-select" data-role="mode" data-index="${i}">${modeOptions(t.mode)}</select>
                ${eventsCell}
                <button class="rs-icon-btn" data-role="remove" data-index="${i}" title="Remove">✕</button>
              </div>
            </li>`;
      })
      .join('')
    : '<li class="rs-empty">No page targets yet.</li>';

  // The blacklist is a plain textarea of names (see the markup below), so there
  // are no rows to build here.

  // Capture the currently-open section before replacing innerHTML —
  // after the swap the template default (section 0) is all that's left.
  const sections = panel.querySelectorAll('.rs-acc-section');
  const currentOpen = Array.from(sections).findIndex((s) => s.classList.contains('rs-acc-open'));

  panel.innerHTML = `
    <div class="rs-accordion">
      <div class="rs-acc-section rs-acc-open">
        <button type="button" class="rs-acc-header">Hotkey</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <input class="rs-input rs-hotkey-input" type="text" readonly
                   value="${escAttr(settings.hotkey)}"
                   placeholder="Click and press a combination" />
            <div class="rs-hint">Click the field, then press the keys you want.
              Use at least one modifier (Ctrl / Alt / Shift / Meta).</div>
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Page targets</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <div class="rs-label-row">
              <button class="rs-btn rs-btn-small" data-role="pick">Pick element…</button>
            </div>
            <div class="rs-hint">Pick an element on the page, then choose what it does.
              A hook opens the popup; the others render the list inline there.</div>
            <ul class="rs-targets">${targetRows}</ul>
            ${hasHook ? '' : `<div class="rs-warn">No hook configured, so hovering or
              clicking will not open the popup. Press <b>${escAttr(settings.hotkey)}</b>
              to open it, or add a hook above.</div>`}
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Blocked subreddits</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <textarea class="rs-input rs-blocked-input" rows="4" spellcheck="false"
                      placeholder="one subreddit per line">${escAttr(settings.blocked.join('\n'))}</textarea>
            <div class="rs-hint">One subreddit per line, without the r/ — the 🗑 button
              adds them here. A blocked subreddit is not tracked again, so delete its
              line to let it back into the list.</div>
          </div>
        </div>
      </div>
      <div class="rs-acc-section">
        <button type="button" class="rs-acc-header">Display options</button>
        <div class="rs-acc-body">
          <div class="rs-field">
            <label class="rs-check">
              <input type="checkbox" class="rs-checkbox" data-role="hide-controls"
                     ${settings.hideRowControls ? 'checked' : ''} />
              <span>Hide row controls until hover</span>
            </label>
            <div class="rs-hint">Hides each row's 📌 and 🗑, and the ✕ in the header,
              until you hover the row they belong to. Keeps the list uncluttered.</div>
          </div>
          <div class="rs-field">
            <label class="rs-check">
              <input type="checkbox" class="rs-checkbox" data-role="show-timestamps"
                     ${settings.showTimestamps ? 'checked' : ''} />
              <span>Show timestamps</span>
            </label>
            <div class="rs-hint">Shows relative timestamps (e.g. "5m ago") next to each
              subreddit in the Recent and Pinned lists. Uncheck for a cleaner look.</div>
          </div>
          <div class="rs-field">
            <label class="rs-label" for="rs-max-recent">Recent history size</label>
            <input class="rs-input rs-number-input" id="rs-max-recent" type="number"
                   data-role="max-recent" min="${MIN_MAX_RECENT}" max="${MAX_MAX_RECENT}"
                   step="1" value="${settings.maxRecent}" />
            <div class="rs-hint">How many recently visited subreddits to keep
              (${MIN_MAX_RECENT}–${MAX_MAX_RECENT}). Pinned subreddits are always kept
              on top of this, so they never count against the limit.</div>
          </div>
        </div>
      </div>
    </div>

    <div class="rs-status"></div>
    <div class="rs-actions">
      <button class="rs-btn" data-role="reset">Reset to default</button>
      <button class="rs-btn rs-btn-primary" data-role="done">Done</button>
    </div>
  `;

  // Accordion: one section open at a time, first open by default.
  // `openSection` (0-based index) overrides the default when provided;
  // otherwise the currently-open section is preserved across re-renders.
  const newSections = panel.querySelectorAll('.rs-acc-section');
  const defaultOpen = openSection ?? Math.max(currentOpen, 0);
  newSections.forEach((s, i) => s.classList.toggle('rs-acc-open', i === defaultOpen));
  panel.querySelectorAll('.rs-acc-header').forEach((header) => {
    header.addEventListener('click', () => {
      const section = header.closest('.rs-acc-section');
      const wasOpen = section.classList.contains('rs-acc-open');
      panel.querySelectorAll('.rs-acc-section').forEach((s) => s.classList.remove('rs-acc-open'));
      if (!wasOpen) section.classList.add('rs-acc-open');
    });
  });

  const input = panel.querySelector('.rs-hotkey-input');

  const say = (msg, kind) => {
    // Re-query: renderSettings() rebuilds the panel, so a captured reference
    // goes stale and the message would land on a detached node.
    const el = panel.querySelector('.rs-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'rs-status ' + (kind === 'error' ? 'rs-status-error' : 'rs-status-ok');
  };

  // Capture the combination: the field is readonly so nothing is typed into it,
  // and the whole keydown is consumed so the host page never sees it.
  input.addEventListener('keydown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.key === 'Escape') {
      input.blur();
      return;
    }

    const combo = comboFromEvent(e);
    if (!combo) {
      say('Press a key along with at least one modifier.', 'error');
      return;
    }

    // Require a modifier: a bare letter would fire while the user is typing in
    // Reddit's own search box.
    if (!e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
      say('Add a modifier (Ctrl / Alt / Shift / Meta).', 'error');
      return;
    }

    const next = { ...loadSettings(), hotkey: combo };
    saveSettings(next);
    input.value = combo;
    ctl.setActiveHotkey(parseHotkey(combo));
    // Release focus: while the field is focused the global handler ignores
    // keydown (the field owns the keys), so leaving it focused would make the
    // hotkey appear not to work until the user clicked elsewhere.
    input.blur();
    say(`Saved — press ${combo} to open the popup.`);
  });

  // ---- Target list ----
  // `host` (declared above) is the instance whose panel is being edited.
  // Settings can be opened from the popup OR from an inline block, so every
  // write re-renders that same host rather than assuming the popup.

  const updateTarget = (index, patch) => {
    const s = loadSettings();
    if (!s.targets[index]) return;
    Object.assign(s.targets[index], patch);
    saveSettings(s);
    ctl.rerender(host);
    // A mode change alters the row's controls, so the instance is rebuilt.
    if ('mode' in patch) ctl.applyTargets();
    const sel = panel.querySelector(`[data-role="mode"][data-index="${index}"]`);
    if (sel && 'mode' in patch) sel.focus();
  };

  panel.querySelector('[data-role="pick"]').addEventListener('click', (e) => {
    e.stopPropagation();
    // Close the popup so the whole page is pickable, then re-open settings after.
    const wasOpen = ctl.isPopupVisible();
    if (wasOpen) ctl.togglePopup(false);

    startPicker(
      (selector) => {
        // onEnd() has already restored the UI by the time this runs.
        const s = loadSettings();
        if (s.targets.some((t) => t.selector === selector)) {
          // Re-picking an element that is already configured is a no-op.
          say('That element is already in the list.', 'error');
          return;
        }
        s.targets.push({ selector, mode: 'hook', events: 'both' });
        saveSettings(s);
        ctl.rerender(host);
        say(`Added ${selector}`);
      },
      () => {
        // Cancelled (Esc) or finished: bring the UI back either way.
        // Open the Page targets section — the picker adds targets, so that is
        // where the user's attention should land.
        ctl.setSettingsOpen(true, host, 1);
        if (wasOpen) ctl.togglePopup(true);
      }
    );
  });

  panel.querySelector('.rs-targets').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-role="remove"]');
    if (!btn) return;
    e.stopPropagation();
    const s = loadSettings();
    s.targets.splice(Number(btn.dataset.index), 1);
    saveSettings(s);
    ctl.rerender(host);
    // A removed target may have been an inline one — tear its block down.
    ctl.applyTargets();
    // Deleting every hook is allowed; say what that leaves you with, since the
    // list otherwise just stops opening on hover with no explanation.
    const hooksLeft = s.targets.some((t) => t.mode === 'hook');
    say(
      hooksLeft
        ? 'Target removed.'
        : `Target removed — no hook left, so use ${s.hotkey} to open the popup.`,
      hooksLeft ? 'ok' : 'error'
    );
  });

  panel.querySelector('.rs-targets').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-role="mode"], [data-role="events"]');
    if (!sel) return;
    e.stopPropagation();
    const index = Number(sel.dataset.index);
    const role = sel.dataset.role;
    updateTarget(index, role === 'mode' ? { mode: sel.value } : { events: sel.value });
    say('Target updated.');
  });

  // ---- Blocked subreddits ----
  // One textarea, one name per line. Saving on `change` (blur / Enter) rather
  // than per keystroke keeps the blacklist from thrashing while a line is being
  // typed, and keydown is stopped from propagating so the popup's global hotkey
  // handler never sees a bare letter typed in here.
  const blockedInput = panel.querySelector('.rs-blocked-input');

  blockedInput.addEventListener('keydown', (e) => {
    // Enter inserts a newline, which is what we want here; just do not let the
    // key reach the document-level hotkey handler.
    e.stopPropagation();
  });

  blockedInput.addEventListener('change', () => {
    const names = blockedInput.value
      .split('\n')
      .map((line) => line.trim().replace(/^\/?r\//i, '').toLowerCase())
      .filter(Boolean);
    const unique = [...new Set(names)];

    const s = loadSettings();
    saveSettings({ ...s, blocked: unique });
    // A name may have been deleted, which lets it be tracked again — repaint the
    // list so it is not left stale.
    ctl.refreshList();
    say(unique.length ? `Saved ${unique.length} blocked subreddit(s).` : 'Blocklist cleared.');
  });

  // ---- Hide row controls ----
  // Applied to every mounted instance immediately, so the effect is visible in
  // the list behind the panel rather than only after reopening it.
  panel.querySelector('[data-role="hide-controls"]').addEventListener('change', (e) => {
    e.stopPropagation();
    const on = e.target.checked;
    saveSettings({ ...loadSettings(), hideRowControls: on });
    ctl.applyControlVisibility();
    say(on ? 'Row controls will show on hover.' : 'Row controls are always shown.');
  });

  // ---- Show timestamps ----
  panel.querySelector('[data-role="show-timestamps"]').addEventListener('change', (e) => {
    e.stopPropagation();
    const on = e.target.checked;
    saveSettings({ ...loadSettings(), showTimestamps: on });
    ctl.refreshList();
    say(on ? 'Timestamps will be shown.' : 'Timestamps will be hidden.');
  });

  // ---- Recent history size ----
  // Saved on `change` (blur / Enter) rather than per keystroke, so a half-typed
  // number is never stored. Lowering the cap prunes what is already stored right
  // away — otherwise the setting would look broken until the next visit, and a
  // list left over the limit would still render in full.
  const maxRecentInput = panel.querySelector('[data-role="max-recent"]');
  maxRecentInput.addEventListener('keydown', (e) => {
    // The popup's global handler must not read a digit typed here as a shortcut.
    e.stopPropagation();
  });
  maxRecentInput.addEventListener('change', () => {
    // Clamp before storing, so the persisted value is the one that will be
    // applied — a junk or out-of-range entry must not be written through and
    // only tidied up on the next read.
    const applied = clampMaxRecent(maxRecentInput.value);
    saveSettings({ ...loadSettings(), maxRecent: applied });
    maxRecentInput.value = String(applied);
    saveData(pruneRecent(loadData(), applied));
    ctl.refreshList();
    say(`Keeping up to ${applied} recent subreddit(s).`);
  });

  panel.querySelector('[data-role="reset"]').addEventListener('click', (e) => {
    e.stopPropagation();
    // defaultSettings() carries the built-in popup trigger, so resetting puts
    // hover/click back — it is a restore, not a wipe.
    saveSettings(defaultSettings());
    ctl.setActiveHotkey(parseHotkey(DEFAULT_SETTINGS.hotkey));
    // The target list changed, so inline blocks must be reconciled too.
    ctl.applyTargets();
    ctl.applyControlVisibility();
    ctl.rerender(host);
    say(`Reset — ${DEFAULT_SETTINGS.hotkey}, and the built-in trigger restored.`);
  });

  panel.querySelector('[data-role="done"]').addEventListener('click', (e) => {
    e.stopPropagation();
    ctl.setSettingsOpen(false, host);
  });
}
