// ==UserScript==
// @name         Recent Subreddits Sidebar
// @namespace    https://github.com/your-username/recent-subreddits
// @version      1.1.0
// @description  Adds a popup menu (triggered by hovering/clicking the Reddit logo) listing recently accessed subreddits with pinning support
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      reddit.com
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Storage ----------
  const STORAGE_KEY = 'recentSubreddits';
  const MAX_RECENT = 15;

  function loadData() {
    try {
      const raw = GM_getValue(STORAGE_KEY, null);
      if (!raw) return { recent: [], pinned: [] };
      const parsed = JSON.parse(raw);
      return {
        recent: Array.isArray(parsed.recent) ? parsed.recent : [],
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
      };
    } catch {
      return { recent: [], pinned: [] };
    }
  }

  function saveData(data) {
    GM_setValue(STORAGE_KEY, JSON.stringify(data));
  }

  // ---------- Subreddit icon cache ----------
  const DEFAULT_ICON =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20'%3E%3Ccircle cx='10' cy='10' r='10' fill='%23b8b8b8'/%3E%3C/svg%3E";

  const iconCache = {};

  function escAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function updateIconInDom(name, icon) {
    if (!sidebarEl || !icon) return;
    const encoded = encodeURIComponent(name);
    sidebarEl.querySelectorAll('img.rs-icon').forEach((img) => {
      if (img.dataset.name === encoded) img.src = icon;
    });
  }

  function fetchSubredditIcon(name) {
    // `name in iconCache` also covers the placeholder set below, so we never
    // fire the same request twice (including after a failed fetch).
    if (name in iconCache) return iconCache[name];

    iconCache[name] = DEFAULT_ICON; // placeholder while loading

    GM_xmlhttpRequest({
      method: 'GET',
      url: `https://www.reddit.com/r/${encodeURIComponent(name)}/about.json`,
      headers: { Accept: 'application/json' },
      onload(res) {
        let icon = '';
        try {
          const data = JSON.parse(res.responseText);
          icon = data.data?.icon_img || data.data?.community_icon || '';
        } catch { /* ignore */ }
        // Reddit sometimes returns an HTML-escaped URL
        icon = icon.replace(/&amp;/g, '&');
        iconCache[name] = icon || DEFAULT_ICON;
        updateIconInDom(name, iconCache[name]);
      },
      onerror() {
        iconCache[name] = DEFAULT_ICON;
      },
    });

    return DEFAULT_ICON;
  }

  // ---------- Extract subreddit from URL ----------
  function getSubredditFromUrl() {
    const path = window.location.pathname;
    // Matches /r/subreddit/... or /r/subreddit
    const match = path.match(/^\/r\/([^/]+)/i);
    if (match) {
      const name = match[1];
      // Skip special entries like "friends", "popular", "all" if desired — keep them for now
      return name.toLowerCase();
    }
    return null;
  }

  // ---------- Track subreddit visit ----------
  function trackVisit(name) {
    const data = loadData();
    // Remove if already in recent (will re-add at top)
    data.recent = data.recent.filter((s) => s.name !== name);
    data.recent.unshift({
      name,
      visitedAt: Date.now(),
    });
    // Trim
    data.recent = data.recent.slice(0, MAX_RECENT);
    saveData(data);
  }

  // ---------- Toggle pin ----------
  function togglePin(name) {
    const data = loadData();
    const pinIndex = data.pinned.indexOf(name);
    if (pinIndex >= 0) {
      data.pinned.splice(pinIndex, 1);
    } else {
      data.pinned.unshift(name);
    }
    saveData(data);
    renderSidebar(data);
  }

  // ---------- Build sidebar element ----------
  let sidebarEl = null;

  function renderSidebar(data) {
    if (!sidebarEl) return;

    const { recent, pinned } = data;

    // Preserve visibility + position across re-renders (pin/unpin replaces innerHTML)
    const wasVisible = isPopupVisible();
    const oldPopup = sidebarEl.querySelector('.recent-subreddits-popup');
    const oldLeft = oldPopup ? oldPopup.style.left : '';
    const oldTop = oldPopup ? oldPopup.style.top : '';

    let html = '<div class="recent-subreddits-popup" id="rs-popup">';
    html += '<button class="rs-close-btn" id="rs-close" title="Close">✕</button>';
    html += '<h3 class="rs-header">📋 Recent Subreddits</h3>';

    if (pinned.length > 0) {
      html += '<div class="rs-section rs-pinned-section">';
      html += '<div class="rs-section-title">📌 Pinned</div>';
      html += '<ul class="rs-list">';
      for (const name of pinned) {
        const icon = iconCache[name] || DEFAULT_ICON;
        html += `<li class="rs-item rs-pinned">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(name)}" class="rs-link">r/${name}</a>`;
        html += `<button class="rs-unpin-btn" data-name="${escAttr(encodeURIComponent(name))}" title="Unpin">✕</button>`;
        html += `</li>`;
      }
      html += '</ul></div>';
    }

    const recentFiltered = recent.filter((s) => !pinned.includes(s.name));

    if (recentFiltered.length > 0) {
      html += '<div class="rs-section">';
      html += '<div class="rs-section-title">🕐 Recent</div>';
      html += '<ul class="rs-list">';
      for (const sub of recentFiltered) {
        const timeAgo = formatTimeAgo(sub.visitedAt);
        const icon = iconCache[sub.name] || DEFAULT_ICON;
        html += `<li class="rs-item">`;
        html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(sub.name))}" src="${escAttr(icon)}" alt="" />`;
        html += `<a href="/r/${encodeURIComponent(sub.name)}" class="rs-link">r/${sub.name}</a>`;
        html += `<span class="rs-time">${timeAgo}</span>`;
        html += `<button class="rs-pin-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Pin">📌</button>`;
        html += `</li>`;
      }
      html += '</ul></div>';
    } else if (pinned.length === 0) {
      html += '<div class="rs-empty">No subreddits visited yet.</div>';
    }

    html += '</div>';
    sidebarEl.innerHTML = html;

    // Restore visibility + position
    const popup = sidebarEl.querySelector('.recent-subreddits-popup');
    if (wasVisible) {
      popup.classList.add('visible');
      if (oldLeft) popup.style.left = oldLeft;
      if (oldTop) popup.style.top = oldTop;
    }

    // Bind events. stopPropagation prevents the document-level "click outside"
    // handler from closing the popup: togglePin() re-renders via innerHTML, which
    // detaches the clicked button, so by the time the event bubbles the popup no
    // longer contains the target and it would be treated as an outside click.
    sidebarEl.querySelectorAll('.rs-pin-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(btn.dataset.name);
      });
    });
    sidebarEl.querySelectorAll('.rs-unpin-btn').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(btn.dataset.name);
      });
    });

    // Fetch icons for any entries missing one
    [...pinned, ...recentFiltered.map((s) => s.name)].forEach((name) => {
      if (!iconCache[name]) fetchSubredditIcon(name);
    });

    // Close popup when mouse leaves it
    if (popup) {
      popup.addEventListener('mouseleave', () => {
        setTimeout(() => {
          if (!isPopupVisible()) return;
          if (popup && !popup.matches(':hover')) {
            togglePopup(false);
          }
        }, 300);
      });
    }
  }

  function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // ---------- Inject styles ----------
  function injectStyles() {
    if (document.getElementById('rs-styles')) return;
    const style = document.createElement('style');
    style.id = 'rs-styles';
    style.textContent = `
      /* Popup container — hidden by default */
      .recent-subreddits-popup {
        --rs-bg: var(--color-tone-4, #f6f7f8);
        --rs-border: var(--color-tone-5, #e4e6e8);
        --rs-text: var(--color-tone-1, #1c1c1c);
        --rs-text-muted: var(--color-tone-3, #7c7c7c);
        --rs-shadow: rgba(0,0,0,0.15);

        display: none;
        position: fixed;
        width: 280px;
        max-height: 70vh;
        overflow-y: auto;
        background: var(--rs-bg);
        border: 1px solid var(--rs-border);
        border-radius: 8px;
        padding: 14px;
        font-size: 13px;
        box-shadow: 0 4px 16px var(--rs-shadow);
        z-index: 10000;
      }
      .recent-subreddits-popup.visible {
        display: block;
        animation: rs-fadein 0.12s ease-out;
      }
      @keyframes rs-fadein {
        from { opacity: 0; transform: translateY(-4px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* Dark mode adaptation */
      @media (prefers-color-scheme: dark) {
        .recent-subreddits-popup {
          --rs-bg: #1a1a1b;
          --rs-border: #343536;
          --rs-text: #d7dadc;
          --rs-text-muted: #818384;
          --rs-shadow: rgba(0,0,0,0.4);
        }
      }
      /* Reddit dark mode class detection */
      body.theme-dark .recent-subreddits-popup,
      html[data-theme="dark"] .recent-subreddits-popup,
      .dark-mode .recent-subreddits-popup {
        --rs-bg: #1a1a1b;
        --rs-border: #343536;
        --rs-text: #d7dadc;
        --rs-text-muted: #818384;
        --rs-shadow: rgba(0,0,0,0.4);
      }

      .rs-header {
        margin: 0 0 8px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--rs-text);
      }
      .rs-section { margin-bottom: 8px; }
      .rs-section:last-child { margin-bottom: 0; }
      .rs-section-title {
        font-weight: 600;
        font-size: 11px;
        text-transform: uppercase;
        color: var(--rs-text-muted);
        margin-bottom: 4px;
      }
      .rs-list {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .rs-item {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0;
        margin: 0;
      }
      .rs-icon {
        width: 20px;
        height: 20px;
        border-radius: 50%;
        object-fit: cover;
        flex-shrink: 0;
        background: var(--rs-border);
        margin: 0;
      }
      .rs-link {
        flex: 1;
        color: var(--rs-text);
        text-decoration: none;
        font-weight: 500;
      }
      .rs-link:hover { text-decoration: underline; }
      .rs-time {
        font-size: 11px;
        color: var(--rs-text-muted);
      }
      .rs-pin-btn, .rs-unpin-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px;
        font-size: 12px;
        opacity: 0.5;
        transition: opacity 0.15s;
      }
      .rs-pin-btn:hover, .rs-unpin-btn:hover { opacity: 1; }
      .rs-empty {
        color: var(--rs-text-muted);
        font-style: italic;
        padding: 8px 0;
      }
      .rs-close-btn {
        position: absolute;
        top: 6px;
        right: 8px;
        background: none;
        border: none;
        cursor: pointer;
        font-size: 14px;
        color: var(--rs-text-muted);
        padding: 2px 4px;
        line-height: 1;
      }
      .rs-close-btn:hover { color: var(--rs-text); }
    `;
    document.head.appendChild(style);
  }

  // ---------- Popup positioning ----------
  function positionPopup(trigger) {
    if (!sidebarEl) return;
    const popup = sidebarEl.querySelector('.recent-subreddits-popup');
    if (!popup || !trigger) return;

    const rect = trigger.getBoundingClientRect();
    const popupWidth = 280;
    const popupHeight = popup.offsetHeight || 300;
    const gap = 8;
    const margin = 16;

    // Horizontal: align left edge with trigger, clamp to viewport
    let left = rect.left;
    if (left + popupWidth > window.innerWidth - margin) {
      left = window.innerWidth - popupWidth - margin;
    }
    if (left < margin) left = margin;

    // Vertical: prefer below trigger, flip above if not enough space
    let top = rect.bottom + gap;
    if (top + popupHeight > window.innerHeight - margin) {
      const aboveTop = rect.top - popupHeight - gap;
      if (aboveTop >= margin) {
        top = aboveTop;
      } else {
        // Neither fits — clamp to viewport with margin
        top = Math.max(margin, Math.min(top, window.innerHeight - popupHeight - margin));
      }
    }

    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
  }

  // ---------- Popup toggle ----------
  function togglePopup(show, trigger) {
    if (!sidebarEl) return;
    const popup = sidebarEl.querySelector('.recent-subreddits-popup');
    if (!popup) return;
    if (show) {
      popup.classList.add('visible');
      if (trigger) positionPopup(trigger);
    } else {
      popup.classList.remove('visible');
    }
  }

  function isPopupVisible() {
    if (!sidebarEl) return false;
    const popup = sidebarEl.querySelector('.recent-subreddits-popup');
    return popup && popup.classList.contains('visible');
  }

  // ---------- Mount popup ----------
  // Combined selector for every element that should trigger the popup.
  // Used with Element.closest() so listeners can live on `document` instead of
  // on the trigger nodes — the host re-renders its header on SPA navigation and
  // would otherwise swap in replacement nodes that carry no listeners.
  const TRIGGER_SELECTOR = [
    'a[href="/"]',                       // Reddit logo link
    '#header-logo',                      // Old Reddit logo
    '.header-logo',                      // Alternative logo class
    '[data-testid="top-nav-logo"]',      // New Reddit logo
    'button[aria-label*="menu" i]',      // Menu button
    '#TopNav button',                    // Top nav button area
    '#reddit-logo',
    '#navbar-menu-button',
  ].join(', ');

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

      const data = loadData();
      renderSidebar(data);
    } else {
      ensureMounted();
    }

    // Event delegation for close button (survives re-renders)
    sidebarEl.addEventListener('click', (e) => {
      if (e.target.closest('.rs-close-btn')) {
        togglePopup(false);
      }
    });

    // ---- Delegated triggers ----
    // Bound once, on `document`. `mouseover` bubbles (unlike `mouseenter`), so a
    // single listener covers every current and future trigger node, including
    // ones the host swaps in during SPA navigation.
    document.addEventListener('mouseover', (e) => {
      const trigger = e.target.closest && e.target.closest(TRIGGER_SELECTOR);
      if (!trigger) return;
      // Ignore movement *within* the trigger (children re-fire mouseover).
      if (e.relatedTarget && trigger.contains(e.relatedTarget)) return;
      togglePopup(true, trigger);
    });

    document.addEventListener('click', (e) => {
      const trigger = e.target.closest && e.target.closest(TRIGGER_SELECTOR);
      if (trigger) {
        if (isPopupVisible()) {
          togglePopup(false);
        } else {
          e.preventDefault();
          togglePopup(true, trigger);
        }
        return;
      }

      // Click outside to close
      if (!isPopupVisible()) return;
      const popup = sidebarEl.querySelector('.recent-subreddits-popup');
      if (popup && !popup.contains(e.target)) {
        togglePopup(false);
      }
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') togglePopup(false);
    });
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
        renderSidebar(loadData());
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
})();
