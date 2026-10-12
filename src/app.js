// The UI shell: mounting, popup visibility, triggers, inline instances, init.
import { parseHotkey, hotkeyMatches } from './hotkey.js';
import {
  loadData,
  loadSettings,
  saveSettings,
  hookTargets,
} from './storage.js';

import { TRIGGER_SELECTOR, checkTriggers } from './diagnostics.js';
import { injectStyles } from './styles.js';
import { getSubredditFromUrl, trackVisit, togglePin as togglePinInStore } from './visits.js';
import { positionPopup, positionPopupCentered } from './position.js';
import { renderContent as renderContentInto } from './content.js';
import { renderSettingsPanel } from './settings-panel.js';

// ---------- Build sidebar element ----------
// Header label per view: icon + title, swapped when the settings panel opens.
const HEADER_TITLE = { main: '📋 Recent Subreddits', settings: '⚙ Settings' };

let sidebarEl = null;
let popupEl = null; // persistent; rebuilt content goes inside #rs-content
let settingsOpen = false;

function isSettingsOpen() {
  return settingsOpen;
}

/**
 * The surface the settings panel needs from the mount layer. Passed in as an
 * object rather than imported, because the mount layer imports the panel —
 * a direct import back would be a cycle.
 */
const panelCtl = {
  rerender: (host) => renderSettings(host),
  setSettingsOpen: (open, instance) => setSettingsOpen(open, instance),
  isPopupVisible: () => isPopupVisible(),
  togglePopup: (show, trigger) => togglePopup(show, trigger),
  applyTargets: () => applyTargets(),
  setActiveHotkey: (combo) => { activeHotkey = combo; },
};

/** Render the settings view into one instance (the popup by default). */
function renderSettings(instance) {
  renderSettingsPanel(instance || popupEl, panelCtl);
}

/** Re-render the list inside every mounted inline block. */
function refreshInlineInstances(data) {
  for (const rec of inlineInstances.values()) {
    if (!document.body.contains(rec.host)) continue;
    renderContent(data, rec.host.querySelector('.rs-inline'));
  }
}

/**
 * Re-render every mounted instance after a store write: the popup and each
 * inline block. Passed to the store layer, which does not know about the DOM.
 */
function refreshAll(data) {
  renderContent(data);
  refreshInlineInstances(data);
}

/** Toggle a pin and repaint every instance showing it. */
function togglePin(name) {
  togglePinInStore(name, refreshAll);
}

/**
 * Build the popup's static shell ONCE. Its inner structure never changes, so
 * the node itself survives every content re-render — which is what lets the
 * settings modal stay open while pins change underneath it.
 */
function buildPopupShell() {
  const popup = document.createElement('div');
  popup.className = 'recent-subreddits-popup rs-instance';
  popup.id = 'rs-popup';

  const close = document.createElement('button');
  close.className = 'rs-close-btn';
  close.id = 'rs-close';
  close.title = 'Close';
  close.textContent = '✕';

  const header = document.createElement('div');
  header.className = 'rs-header-row';

  const title = document.createElement('h3');
  title.className = 'rs-header';
  title.textContent = HEADER_TITLE.main;

  const back = document.createElement('button');
  back.className = 'rs-back-btn';
  back.id = 'rs-back';
  back.title = 'Back';
  back.textContent = '←';

  const gear = document.createElement('button');
  gear.className = 'rs-settings-btn';
  gear.id = 'rs-settings';
  gear.title = 'Settings';
  gear.textContent = '⚙';

  header.append(back, title, gear, close);

  const content = document.createElement('div');
  content.className = 'rs-content';

  const settings = document.createElement('div');
  settings.className = 'rs-settings-panel';

  popup.append(header, content, settings);
  return popup;
}

/** The list renders into whichever instance is given; the popup by default. */
function renderContent(data, instance) {
  renderContentInto(data, instance || popupEl, () => !!sidebarEl);
}

// ---------- Inline instances (replace / prepend / append) ----------
// Each inline target gets a full instance of the UI — header, list, settings —
// built from the same shell as the popup, minus the popup-only chrome. The
// block is inserted NEXT TO the picked element rather than inside it, and the
// element is hidden with visibility (not display/remove) so the host's own
// layout, event handlers and framework references stay intact.
const inlineInstances = new Map(); // selector -> { el, host, mode }

const INLINE_MODES = ['replace', 'prepend', 'append'];

function buildInlineInstance() {
  const inst = buildPopupShell();

  // Inline blocks are always visible and are not a popup: drop the popup's
  // classes and positioning, but keep the shared instance class that carries
  // the content/settings swap rules.
  inst.classList.remove('recent-subreddits-popup');
  inst.classList.add('rs-inline', 'rs-instance');
  inst.removeAttribute('id');
  inst.classList.remove('visible');
  // The close button's job here is to drop the binding, not to hide a popup.
  const close = /** @type {HTMLElement|null} */ (inst.querySelector('.rs-close-btn'));
  if (close) close.title = 'Remove this binding';

  // The inline block has no anchor, so a hotkey-positioned popup is irrelevant.
  return inst;
}

/** Copy the host element's box so a replace keeps the page's layout. */
function matchElementBox(inst, el) {
  const rect = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  // Only adopt a real size — a hidden or zero-height element must not collapse
  // the block to nothing.
  if (rect.width > 0) {
    inst.style.width = rect.width + 'px';
    inst.style.maxWidth = '100%';
  }
  // Keep it from inheriting the host's own typography or colour rules.
  if (cs.fontSize) inst.style.fontSize = cs.fontSize;

  // Absorb the host element's positioning so a sticky/fixed replacement
  // sticks the same way the original did.
  if (cs.position !== 'static') {
    inst.style.position = cs.position;
    if (cs.top !== 'auto') inst.style.top = cs.top;
    if (cs.right !== 'auto') inst.style.right = cs.right;
    if (cs.bottom !== 'auto') inst.style.bottom = cs.bottom;
    if (cs.left !== 'auto') inst.style.left = cs.left;
    if (cs.zIndex !== 'auto') inst.style.zIndex = cs.zIndex;
  }
  if (cs.margin !== '0px') inst.style.margin = cs.margin;
  if (cs.boxSizing) inst.style.boxSizing = cs.boxSizing;
}

/** Mount (or refresh) one inline instance for a target. */
function mountInlineInstance(target) {
  const { selector, mode } = target;

  let el;
  try {
    el = document.querySelector(selector);
  } catch {
    return; // a hand-typed selector may be invalid
  }
  if (!el) return; // nothing on this page matches; nothing to do

  let rec = inlineInstances.get(selector);

  // Rebuild when the mode changed or the block was detached by the host.
  if (rec && (rec.mode !== mode || !document.body.contains(rec.host))) {
    rec.host.remove();
    rec = null;
  }

  if (!rec) {
    const inst = buildInlineInstance();
    const host = document.createElement('div');
    host.className = 'rs-inline-host' + (mode === 'replace' ? ' rs-inline-host-replace' : '');
    host.dataset.rsSelector = selector;
    host.appendChild(inst);

    // Add a resize handle so the user can adjust the block size.
    const handle = document.createElement('div');
    handle.className = 'rs-resize-handle';
    host.appendChild(handle);

    // Placement relative to the picked element.
    if (mode === 'replace') {
      // Nest inside the element and overlap it — avoids leaving a gap
      // in the document flow where the hidden element used to be.
      el.style.visibility = 'hidden';
      el.appendChild(host);
    } else if (mode === 'prepend') {
      el.insertBefore(host, el.firstChild);
    } else {
      el.appendChild(host);
    }

    if (mode === 'replace') matchElementBox(inst, el);

    // Restore a previously saved size.
    if (target.size) {
      if (target.size.width) inst.style.width = target.size.width;
      if (target.size.height) inst.style.maxHeight = target.size.height;
    }

    rec = { el, host, mode };
    inlineInstances.set(selector, rec);
    wireInlineInstance(rec, target);
  }

  renderContent(loadData(), rec.host.querySelector('.rs-inline'));
}

/** Wire the resize handle so the user can drag the block to a new size. */
function wireResizeHandle(rec, target) {
  const handle = rec.host.querySelector('.rs-resize-handle');
  const inst = rec.host.querySelector('.rs-inline');
  if (!handle || !inst) return;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = inst.offsetWidth;
    const startH = inst.offsetHeight;

    const onMove = (ev) => {
      const newW = Math.max(80, startW + ev.clientX - startX);
      const newH = Math.max(60, startH + ev.clientY - startY);
      inst.style.width = newW + 'px';
      inst.style.maxHeight = newH + 'px';
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Persist the new size so it survives re-mounts.
      const s = loadSettings();
      const t = s.targets.find((t) => t.selector === target.selector);
      if (t) {
        t.size = { width: inst.style.width, maxHeight: inst.style.maxHeight };
        saveSettings(s);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

/** Delegated handlers for one inline block. */
function wireInlineInstance(rec, target) {
  const inst = rec.host.querySelector('.rs-inline');
  if (!inst) return;

  wireResizeHandle(rec, target);

  // Pin/unpin, close (unbind), settings toggle — same behaviour as the popup,
  // but scoped to this block and with no popup to open or close.
  inst.addEventListener('click', (e) => {
    const pin = e.target.closest('.rs-pin-btn, .rs-unpin-btn');
    if (pin) {
      e.stopPropagation();
      togglePin(pin.dataset.name);
      return;
    }
    if (e.target.closest('.rs-close-btn')) {
      e.stopPropagation();
      // The close button removes this binding instead of closing a popup.
      removeTargetBySelector(target.selector);
      return;
    }
    if (e.target.closest('.rs-back-btn')) {
      e.stopPropagation();
      setSettingsOpen(false, inst);
      return;
    }
    if (e.target.closest('.rs-settings-btn')) {
      e.stopPropagation();
      setSettingsOpen(!inst.classList.contains('settings-open'), inst);
    }
    // Keep clicks inside the block from reaching the document handlers, which
    // would read them as an outside click and close the popup.
    e.stopPropagation();
  });
}

function removeTargetBySelector(selector) {
  const s = loadSettings();
  const i = s.targets.findIndex((t) => t.selector === selector);
  if (i < 0) return;
  s.targets.splice(i, 1);
  saveSettings(s);
  applyTargets();
}

/**
 * Reconcile the DOM with the configured inline targets: mount what is missing,
 * tear down what is no longer configured, and unhide elements we had hidden.
 * Safe to call after any settings write or navigation.
 */
function applyTargets() {
  if (!document.body) return;
  const wanted = loadSettings().targets.filter((t) => INLINE_MODES.includes(t.mode));

  // Tear down instances whose target is gone or whose mode left the inline set.
  for (const [selector, rec] of Array.from(inlineInstances.entries())) {
    const stillWanted = wanted.some((t) => t.selector === selector);
    if (!stillWanted) {
      // Un-hide the element we replaced, or it stays invisible forever.
      if (rec.el && rec.el.style.visibility === 'hidden') rec.el.style.visibility = '';
      rec.host.remove();
      inlineInstances.delete(selector);
    }
  }

  for (const t of wanted) mountInlineInstance(t);
}

function setSettingsOpen(open, instance) {
  const host = instance || popupEl;
  if (!host) return;

  // Only the popup tracks this flag; an inline block's panel is toggled by
  // its own gear and never blocks the global Escape handling.
  if (host === popupEl) settingsOpen = open;

  host.classList.toggle('settings-open', open);
  const title = host.querySelector('.rs-header');
  if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
  if (open) renderSettings(host);
}

// Kept in a module-level variable so the hotkey can change without rebinding.
let activeHotkey = null;

// The element the popup is currently anchored to, so it can be re-positioned
// without the caller having to pass the trigger again.
let lastTrigger = null;

// ---------- Popup toggle ----------
function togglePopup(show, trigger) {
  if (!popupEl) return;
  if (show) {
    // Remember the anchor so re-opening after a pick lands in the same place
    // instead of snapping to the centre.
    if (trigger) lastTrigger = trigger;
    popupEl.classList.add('visible');
    if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
    else positionPopupCentered(popupEl);
  } else {
    popupEl.classList.remove('visible');
    // Never leave the settings modal open behind a closed popup.
    setSettingsOpen(false);
  }
}

function isPopupVisible() {
  return !!popupEl && popupEl.classList.contains('visible');
}

// ---------- Mount popup ----------
/**
 * Resolve an event target to `{el, events}` if it is a popup trigger, else null.
 * A user hook wins over the built-in selectors so its own event choice applies.
 */
function resolveTrigger(target) {
  if (!target || typeof target.closest !== 'function') return null;

  for (const t of hookTargets()) {
    let el;
    try {
      el = target.closest(t.selector);
    } catch {
      // A selector the user typed by hand may be invalid — ignore it.
      continue;
    }
    if (el) return { el, events: t.events };
  }

  const builtin = target.closest(TRIGGER_SELECTOR);
  // The stock logo triggers keep the original behaviour: hover and click.
  if (builtin) return { el: builtin, events: 'both' };

  return null;
}

const wantsHover = (events) => events === 'hover' || events === 'both';
const wantsClick = (events) => events === 'click' || events === 'both';

// ---------- Keep our own nodes alive ----------
// The wrapper lives on document.body, but the host can replace body content
// (or head) on navigation. Re-append if we were detached.
function ensureMounted() {
  if (!sidebarEl) return;

  if (!document.body.contains(sidebarEl)) {
    document.body.appendChild(sidebarEl);
  }

  if (!document.getElementById('rs-styles')) {
    injectStyles();
  }
}

function mountSidebar() {
  if (!sidebarEl) {
    // Create a wrapper appended to body
    sidebarEl = document.createElement('div');
    sidebarEl.className = 'recent-subreddits-container';
    document.body.appendChild(sidebarEl);

    popupEl = buildPopupShell();
    sidebarEl.appendChild(popupEl);
    activeHotkey = parseHotkey(loadSettings().hotkey);

    renderContent(loadData());
    // Mount any configured inline blocks on this page.
    applyTargets();
  } else {
    ensureMounted();
    applyTargets();
  }

  // ---- Delegated listeners on the wrapper ----
  // One listener each, on nodes that are never rebuilt, so content re-renders
  // cannot drop them. stopPropagation keeps the document-level "click outside"
  // handler from closing the popup when one of its own controls is used.
  sidebarEl.addEventListener('click', (e) => {
    const pin = e.target.closest('.rs-pin-btn, .rs-unpin-btn');
    if (pin) {
      e.stopPropagation();
      togglePin(pin.dataset.name);
      return;
    }
    if (e.target.closest('.rs-close-btn')) {
      e.stopPropagation();
      togglePopup(false);
      return;
    }
    if (e.target.closest('.rs-back-btn')) {
      e.stopPropagation();
      setSettingsOpen(false);
    }
    if (e.target.closest('.rs-settings-btn')) {
      e.stopPropagation();
      setSettingsOpen(!isSettingsOpen());
    }
    // Clicks anywhere else inside the popup are swallowed here so they cannot
    // reach the document handler and be read as an outside click.
    e.stopPropagation();
  });

  // Close popup when the pointer leaves it, with a grace period so the pointer
  // can travel from the trigger into the popup.
  sidebarEl.addEventListener('mouseleave', () => {
    setTimeout(() => {
      if (!isPopupVisible()) return;
      if (popupEl && !popupEl.matches(':hover')) togglePopup(false);
    }, 300);
  });

  // ---- Delegated triggers ----
  // Bound once, on `document`. `mouseover` bubbles (unlike `mouseenter`), so a
  // single listener covers every current and future trigger node, including
  // ones the host swaps in during SPA navigation.
  document.addEventListener('mouseover', (e) => {
    const hit = resolveTrigger(e.target);
    if (!hit || !wantsHover(hit.events)) return;
    // Ignore movement *within* the trigger (children re-fire mouseover).
    if (e.relatedTarget && hit.el.contains(e.relatedTarget)) return;
    togglePopup(true, hit.el);
  });

  document.addEventListener('click', (e) => {
    const hit = resolveTrigger(e.target);
    if (hit && wantsClick(hit.events)) {
      if (isPopupVisible()) {
        togglePopup(false);
      } else {
        e.preventDefault();
        togglePopup(true, hit.el);
      }
      return;
    }
    // A click-only target's click must not fall through to "close the popup".
    if (hit) return;

    // Click outside to close
    if (!isPopupVisible()) return;
    if (popupEl && !popupEl.contains(e.target)) {
      togglePopup(false);
    }
  });

  // ---- Keyboard ----
  document.addEventListener('keydown', (e) => {
    // The settings field handles its own keys and consumes them.
    const target = /** @type {HTMLElement} */ (e.target);
    if (target && target.classList && target.classList.contains('rs-hotkey-input')) return;

    if (e.key === 'Escape') {
      // Escape closes the settings modal first, then the popup.
      if (isSettingsOpen()) {
        setSettingsOpen(false);
        return;
      }
      togglePopup(false);
      return;
    }

    if (hotkeyMatches(e, activeHotkey)) {
      e.preventDefault();
      // The escape hatch: works with no trigger on the page at all.
      if (isPopupVisible()) togglePopup(false);
      else togglePopup(true);
    }
  });

  // Warn (once) if no trigger matched — the signature of a Reddit markup change.
  checkTriggers();
}

// ---------- SPA navigation detection ----------
function observeNavigation() {
  let lastUrl = window.location.href;

  const observer = new MutationObserver(() => {
    // The host may have swapped our wrapper (or the <style>) out from under us.
    ensureMounted();

    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      const subName = getSubredditFromUrl();
      if (subName) {
        trackVisit(subName);
      }
      renderContent(loadData());
      // The new view replaced the DOM: inline hosts may be gone, and the new
      // view may have elements matching targets that were absent before.
      // Only on a URL change — applyTargets() inserts nodes, and calling it on
      // every mutation would fight the observer's own trigger.
      applyTargets();
      // The new view may have a header we do not recognise.
      checkTriggers();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

// ---------- Init ----------
function init() {
  injectStyles();

  // Track the current page
  const subName = getSubredditFromUrl();
  if (subName) {
    trackVisit(subName);
  }

  mountSidebar();
  observeNavigation();
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
