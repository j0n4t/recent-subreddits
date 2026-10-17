// List rendering
//
// The recent/pinned list as HTML. One function renders into whichever instance
// is passed — the popup or any inline block — because they share the shell.
import { formatTimeAgo } from './time.js';
import { cachedIcon, fetchSubredditIcon } from './icons.js';
import { escAttr } from './html.js';

/**
 * Render the recent/pinned list into one instance's content slot.
 * `instance` is the node whose `.rs-content` gets the list.
 * `isMounted()` reports whether the UI is still in the document.
 * `showTimestamps` controls whether the relative-time column is rendered.
 */
export function renderContent(data, instance, isMounted, showTimestamps = true) {
  if (!instance) return;

  const content = instance.querySelector('.rs-content');
  if (!content) return;

  const { recent, pinned } = data;

  // Pinned entries are stored as plain names, but the visit timestamp lives in
  // the recent list. Build a lookup so pinned rows can show it too.
  const visitedAtByName = new Map(recent.map((s) => [s.name, s.visitedAt]));

  let html = '';

  if (pinned.length > 0) {
    html += '<div class="rs-section rs-pinned-section">';
    html += '<div class="rs-section-title">📌 Pinned</div>';
    html += '<ul class="rs-list">';
    pinned.forEach((name) => {
      const icon = cachedIcon(name);
      html += `<li class="rs-item rs-pinned">`;
      html += `<span class="rs-drag-handle" data-name="${escAttr(encodeURIComponent(name))}" title="Drag to reorder" draggable="true">⠿</span>`;
      html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(name))}" src="${escAttr(icon)}" alt="" />`;
      html += `<a href="/r/${encodeURIComponent(name)}" class="rs-link">r/${name}</a>`;
      if (showTimestamps) {
        const visitedAt = visitedAtByName.get(name);
        if (visitedAt) {
          html += `<span class="rs-time">${formatTimeAgo(visitedAt)}</span>`;
        }
      }
      html += `<button class="rs-unpin-btn" data-name="${escAttr(encodeURIComponent(name))}" title="Unpin">✕</button>`;
      html += `</li>`;
    });
    html += '</ul></div>';
  }

  const recentFiltered = recent.filter((s) => !pinned.includes(s.name));

  if (recentFiltered.length > 0) {
    html += '<div class="rs-section">';
    html += '<div class="rs-section-title">🕐 Recent</div>';
    html += '<ul class="rs-list">';
    for (const sub of recentFiltered) {
      const icon = cachedIcon(sub.name);
      html += `<li class="rs-item">`;
      html += `<button class="rs-pin-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Pin">📌</button>`;
      html += `<img class="rs-icon" data-name="${escAttr(encodeURIComponent(sub.name))}" src="${escAttr(icon)}" alt="" />`;
      html += `<a href="/r/${encodeURIComponent(sub.name)}" class="rs-link">r/${sub.name}</a>`;
      if (showTimestamps) {
        const timeAgo = formatTimeAgo(sub.visitedAt);
        html += `<span class="rs-time">${timeAgo}</span>`;
      }
      // The trash removes the entry from history. Recent rows only: the Pinned
      // section already has its own ✕ unpin control.
      html += `<button class="rs-remove-btn" data-name="${escAttr(encodeURIComponent(sub.name))}" title="Remove from history">🗑</button>`;
      html += `</li>`;
    }
    html += '</ul></div>';
  } else if (pinned.length === 0) {
    html += '<div class="rs-empty">No subreddits visited yet.</div>';
  }

  content.innerHTML = html;

  // Fetch icons for any entries missing one. fetchSubredditIcon() no-ops for a
  // name already cached, so no guard is needed here.
  [...pinned, ...recentFiltered.map((s) => s.name)].forEach((name) => {
    fetchSubredditIcon(name, isMounted);
  });
}
