// The UI shell: mounting, popup visibility, triggers, inline instances, init.
import { parseHotkey, hotkeyMatches } from './hotkey.js';
import {
  loadData,
  loadSettings,
} from './storage.js';

import { checkTriggers } from './diagnostics.js';
import { injectStyles } from './styles.js';
import { getSubredditFromUrl, trackVisit, togglePin as togglePinInStore } from './visits.js';
import { positionPopup, positionPopupCentered } from './position.js';
import { renderContent as renderContentInto } from './content.js';
import { renderSettingsPanel } from './settings-panel.js';
import { initInline, refreshInline, applyTargets } from './inline.js';
import { resolveTrigger, wantsHover, wantsClick } from './triggers.js';

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
  rerender: renderSettings,
  setSettingsOpen,
  isPopupVisible,
  togglePopup,
  applyTargets,
  // A setter, not a function reference: the panel replaces the active combo.
  setActiveHotkey: (combo) => { activeHotkey = combo; },
};

/** Render the settings view into one instance (the popup by default). */
function renderSettings(instance) {
  renderSettingsPanel(instance || popupEl, panelCtl);
}

/**
 * Re-render every mounted instance after a store write: the popup and each
 * inline block. Passed to the store layer, which does not know about the DOM.
 */
function refreshAll(data) {
  renderContent(data);
  refreshInline(data);
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
  // The inline layer calls back into the shell; install its surface once.
  initInline({
    buildPopupShell,
    render: renderContent,
    togglePin,
    setSettingsOpen,
  });

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
