// The UI shell: mounting, popup visibility, triggers, inline instances, init.
import { parseHotkey, hotkeyMatches } from './hotkey.js';
import {
  loadData,
  loadSettings,
} from './storage.js';

import { checkTriggers, checkHarvest } from './diagnostics.js';
import { injectStyles } from './styles.js';
import { getSubredditFromUrl, trackVisit, togglePin as togglePinInStore, removeVisit as removeVisitInStore, movePinned as movePinnedInStore } from './visits.js';
import { harvestCurrentSubredditIcon, harvestSignals } from './icons.js';
import { positionPopup, positionPopupCentered } from './position.js';
import { renderContent as renderContentInto } from './content.js';
import { renderSettingsPanel } from './settings-panel.js';
import { initInline, refreshInline, applyTargets } from './inline.js';
import { resolveTrigger, wantsHover, wantsClick } from './triggers.js';
import { hookTargets } from './storage.js';

// ---------- Build sidebar element ----------
// Header label per view: icon + title, swapped when the settings panel opens.
const HEADER_TITLE = { main: '📋 Recent Subreddits', settings: '⚙ Settings' };

let sidebarEl = null;
let popupEl = null; // persistent; rebuilt content goes inside #rs-content
let settingsOpen = false;

// Periodic refresh while the popup is open so timestamps age.
let refreshTimer = null;
const REFRESH_INTERVAL_MS = 30_000;

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
  refreshList,
  applyControlVisibility,
  // A setter, not a function reference: the panel replaces the active combo.
  setActiveHotkey: (combo) => { activeHotkey = combo; },
};

/** Render the settings view into one instance (the popup by default). */
function renderSettings(instance, openSection) {
  renderSettingsPanel(instance || popupEl, panelCtl, openSection);
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

/** Reorder a pinned subreddit and repaint every instance showing it. */
function movePinned(name, direction) {
  movePinnedInStore(name, direction, refreshAll);
}

/** Drop a subreddit from history and repaint every instance showing it. */
function removeVisit(name) {
  removeVisitInStore(name, refreshAll);
}

/** Repaint the list in every mounted instance. */
function refreshList() {
  refreshAll(loadData());
  // The list's height changes with its contents (a removal shortens it, a pin
  // adds a section), and the popup's placement is derived from that height.
  repositionPopup();
}

/**
 * Whether row controls are revealed on hover instead of always shown.
 *
 * The class goes on the instance, and the CSS keys off it, so the default
 * (off) needs no rules at all. Applied to every mounted instance — the popup
 * and each inline block — because the setting is global.
 */
function applyControlVisibility() {
  const hide = loadSettings().hideRowControls;
  for (const el of document.querySelectorAll('.rs-instance')) {
    el.classList.toggle('rs-hide-controls', hide);
  }
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
  // Inline instances are built from this same shell, so the setting lands on
  // them too without a second call site.
  if (loadSettings().hideRowControls) popup.classList.add('rs-hide-controls');

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
  renderContentInto(data, instance || popupEl, () => !!sidebarEl, loadSettings().showTimestamps);
}

/**
 * Take the current subreddit's icon off the page, then repaint if it changed.
 *
 * Called before the first render, on SPA navigation, and whenever the popup
 * opens. It must run BEFORE a render, not after: the render queues the fallback
 * fetches, and an icon already harvested is one that never needs fetching.
 * Safe to call before the popup exists — the icon is recorded either way, and
 * there is simply nothing to repaint yet.
 */
function harvestIcon() {
  const adopted = harvestCurrentSubredditIcon(() => !!sidebarEl);
  if (adopted && sidebarEl) renderContent(loadData());
  // Report a harvest that should have worked and did not. This sits at the
  // harvest attempt rather than at one call site, so all three get it: mount,
  // popup open, and SPA navigation. The popup-open call doubles as the late
  // re-check for a header that rendered after mount. warnOnce dedupes, so this
  // is at most one warning per page.
  checkHarvest(harvestSignals());
}

function setSettingsOpen(open, instance, openSection) {
  const host = instance || popupEl;
  if (!host) return;

  // Only the popup tracks this flag; an inline block's panel is toggled by
  // its own gear and never blocks the global Escape handling.
  if (host === popupEl) settingsOpen = open;

  host.classList.toggle('settings-open', open);
  const title = host.querySelector('.rs-header');
  if (title) title.textContent = open ? HEADER_TITLE.settings : HEADER_TITLE.main;
  if (open) renderSettings(host, openSection);
  // The panel is a very different height from the list, so the popup has to be
  // placed again or it keeps the position chosen for the other view.
  if (host === popupEl) repositionPopup();
}

// Kept in a module-level variable so the hotkey can change without rebinding.
let activeHotkey = null;

// The element the popup is currently anchored to, so it can be re-positioned
// without the caller having to pass the trigger again.
let lastTrigger = null;

// ---------- Timestamp aging ----------
// formatTimeAgo runs at render only, so without a refresh an open popup keeps
// showing "just now" indefinitely. A 30s interval re-renders the list while the
// popup is visible, which keeps the timestamps honest without being wasteful.
function startRefreshTimer() {
  if (refreshTimer) return;
  refreshTimer = setInterval(() => {
    if (isPopupVisible()) refreshList();
  }, REFRESH_INTERVAL_MS);
}

function stopRefreshTimer() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ---------- Popup toggle ----------
function togglePopup(show, trigger) {
  if (!popupEl) return;
  if (show) {
    // Remember the anchor so re-opening after a pick lands in the same place
    // instead of snapping to the centre.
    if (trigger) lastTrigger = trigger;
    // Whatever the page can tell us about the current subreddit's icon is free;
    // take it before showing the list.
    harvestIcon();
    popupEl.classList.add('visible');
    if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
    else positionPopupCentered(popupEl);
    startRefreshTimer();
  } else {
    popupEl.classList.remove('visible');
    stopRefreshTimer();
    // Never leave the settings modal open behind a closed popup.
    setSettingsOpen(false);
  }
}

function isPopupVisible() {
  return !!popupEl && popupEl.classList.contains('visible');
}

/**
 * Re-place the popup at its current anchor.
 *
 * The height the placement math reads is the height the popup has RIGHT NOW, so
 * anything that changes its content has to place it again — otherwise the popup
 * keeps the position chosen for its old size. Opening the settings panel is the
 * case that bit: it grows the popup from the list's height to roughly 500px, and
 * a popup that was placed to fit as a short list then ran off the bottom of the
 * viewport with its Done button unreachable.
 *
 * No-op while hidden: positionPopup() reads offsetHeight, which is 0 for a
 * display:none element, so placing it now would store a nonsense position.
 */
function repositionPopup() {
  if (!isPopupVisible()) return;
  if (lastTrigger && document.body.contains(lastTrigger)) positionPopup(popupEl, lastTrigger);
  else positionPopupCentered(popupEl);
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
    movePinned,
    removeVisit,
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

    // Harvest before the first render: the render queues a fallback fetch for
    // every unresolved row, so an icon already on the page must be recorded first
    // or it gets fetched anyway.
    harvestIcon();
    renderContent(loadData());
    // Mount any configured inline blocks on this page.
    applyTargets();
    // The stored preference is applied to every instance as it mounts.
    applyControlVisibility();
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
    const reorder = e.target.closest('.rs-reorder-up, .rs-reorder-down');
    if (reorder) {
      e.stopPropagation();
      movePinned(reorder.dataset.name, reorder.classList.contains('rs-reorder-up') ? 'up' : 'down');
      return;
    }
    const remove = e.target.closest('.rs-remove-btn');
    if (remove) {
      e.stopPropagation();
      removeVisit(remove.dataset.name);
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

    // Keyboard navigation: only in the popup, not inline blocks.
    if (isPopupVisible() && !isSettingsOpen()) {
      const items = Array.from(popupEl.querySelectorAll('.rs-content .rs-item'));
      if (items.length > 0) {
        const currentHighlight = items.findIndex(el => el.classList.contains('rs-highlighted'));

        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const dir = e.key === 'ArrowDown' ? 1 : -1;
          let next;
          if (currentHighlight === -1) {
            next = dir === 1 ? 0 : items.length - 1;
          } else {
            next = currentHighlight + dir;
            if (next < 0) next = items.length - 1;
            if (next >= items.length) next = 0;
          }
          items.forEach(el => el.classList.remove('rs-highlighted'));
          items[next].classList.add('rs-highlighted');
          return;
        }

        if (currentHighlight !== -1) {
          const highlighted = items[currentHighlight];
          const name = highlighted.querySelector('.rs-link').textContent.trim().replace(/^r\//, '');

          if (e.key === 'Enter') {
            e.preventDefault();
            window.location.href = `/r/${encodeURIComponent(name)}`;
            return;
          }

          if (e.key === 'Insert') {
            e.preventDefault();
            togglePin(name);
            return;
          }

          if (e.key === 'Delete') {
            e.preventDefault();
            if (highlighted.classList.contains('rs-pinned')) {
              togglePin(name);
            } else {
              removeVisit(name);
            }
            return;
          }
        }
      }
    }

    if (hotkeyMatches(e, activeHotkey)) {
      e.preventDefault();
      // The escape hatch: works with no trigger on the page at all.
      if (isPopupVisible()) togglePopup(false);
      else togglePopup(true);
    }
  });

  // Warn (once) if the configured hooks match nothing on this page — the
  // signature of a Reddit markup change. Silent when no hook is configured:
  // that is a deliberate choice, and the settings panel already says so.
  checkTriggers(hookTargets().map((t) => t.selector));
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
      // The page may already be showing the new subreddit's icon. Reddit
      // re-renders that anchor a beat after the URL changes (measured ~1s), so
      // harvestIcon() is also called when the popup opens, which is the read
      // that actually lands after the new icon exists.
      harvestIcon();
      renderContent(loadData());
      // The new view replaced the DOM: inline hosts may be gone, and the new
      // view may have elements matching targets that were absent before.
      // Only on a URL change — applyTargets() inserts nodes, and calling it on
      // every mutation would fight the observer's own trigger.
      applyTargets();
      // The new view may have a header we do not recognise.
      checkTriggers(hookTargets().map((t) => t.selector));
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
  // The page may already be showing this subreddit's icon: adopt it now, so the
  // very first render has it without any fetch.
  harvestIcon();
}

// Wait for DOM to be ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
