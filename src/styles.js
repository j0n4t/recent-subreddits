// Styles
//
// One stylesheet, injected once. The design tokens are declared on both the
// popup and .rs-inline because CSS custom properties do not inherit between
// siblings — the inline block re-declares them so every var() resolves.
export function injectStyles() {
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
      --rs-accent: #d93a00;
      --rs-accent-soft: rgba(217,58,0,0.25);
      --rs-ok: #1a7f37;
      --rs-error: #c9252d;

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
        --rs-ok: #4ac26b;
        --rs-error: #ff7b72;
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
      --rs-ok: #4ac26b;
      --rs-error: #ff7b72;
    }

    .rs-header-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 0 8px 0;
    }
    .rs-header {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
      color: var(--rs-text);
    }
    .rs-back-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 14px;
      line-height: 1;
      color: var(--rs-text-muted);
      display: none;
      transition: color 0.15s;
    }
    /* ---- Shared instance chrome ---- */
    /* The popup and the inline blocks are the same UI in two containers, so
       the view-swap rules key off a shared class rather than the popup's. */
    .rs-instance.settings-open .rs-content { display: none; }
    .rs-instance.settings-open .rs-settings-panel { display: block; }
    .rs-instance.settings-open .rs-back-btn { display: block; }
    /* The gear is redundant next to the "⚙ Settings" title; back is the way out. */
    .rs-instance.settings-open .rs-settings-btn { display: none; }

    .rs-settings-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 13px;
      line-height: 1;
      opacity: 0.6;
      color: var(--rs-text);
      transition: opacity 0.15s, transform 0.2s;
    }
    .rs-settings-btn:hover { opacity: 1; transform: rotate(30deg); }

    /* ---- Settings modal ---- */
    /* Hidden by default; .settings-open on the instance swaps content for it. */
    .rs-settings-panel { display: none; }

    .rs-field { margin-bottom: 10px; }
    .rs-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--rs-text-muted);
      margin-bottom: 4px;
    }
    .rs-input {
      width: 100%;
      box-sizing: border-box;
      padding: 6px 8px;
      font-size: 13px;
      font-family: inherit;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-input:focus {
      outline: none;
      border-color: var(--rs-accent);
      box-shadow: 0 0 0 2px var(--rs-accent-soft);
    }
    .rs-hint {
      font-size: 11px;
      color: var(--rs-text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }
    .rs-status {
      font-size: 11px;
      min-height: 14px;
      margin-bottom: 4px;
    }
    .rs-status-ok { color: var(--rs-ok); }
    .rs-status-error { color: var(--rs-error); }

    /* ---- Page targets ---- */
    .rs-label-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 4px;
    }
    .rs-label-row .rs-label { margin-bottom: 0; }
    .rs-btn-small {
      padding: 3px 8px;
      font-size: 11px;
    }
    .rs-targets {
      list-style: none;
      margin: 8px 0 0 0;
      padding: 0;
    }
    .rs-target {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 0;
      border-top: 1px solid var(--rs-border);
    }
    .rs-target:first-child { border-top: none; }
    .rs-target-sel {
      font-family: monospace;
      font-size: 11px;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 3px;
      padding: 2px 5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .rs-target-controls {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .rs-select {
      flex: 1;
      min-width: 0;
      padding: 3px 4px;
      font-size: 11px;
      font-family: inherit;
      color: var(--rs-text);
      background: var(--rs-bg);
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-select:focus {
      outline: none;
      border-color: var(--rs-accent);
    }
    .rs-muted {
      flex: 1;
      font-size: 11px;
      color: var(--rs-text-muted);
      text-align: center;
    }
    .rs-icon-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px 4px;
      font-size: 12px;
      line-height: 1;
      color: var(--rs-text-muted);
    }
    .rs-icon-btn:hover { color: var(--rs-error); }
    .rs-actions {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }
    .rs-btn {
      display: flex;
      align-items: center;
      padding: 5px 10px;
      font-size: 12px;
      font-family: inherit;
      color: var(--rs-text);
      background: none;
      border: 1px solid var(--rs-border);
      border-radius: 4px;
      cursor: pointer;
    }
    .rs-btn:hover { border-color: var(--rs-text-muted); }
    .rs-btn-primary {
      background: var(--rs-accent);
      border-color: var(--rs-accent);
      color: #fff;
      font-weight: 600;
    }
    .rs-btn-primary:hover { opacity: 0.9; }
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
    /* ---- Inline instances (replace / prepend / append) ---- */
    /* Same UI as the popup, but in the page flow with no border or shadow.
       The design tokens live on .recent-subreddits-popup, so the inline block
       re-declares them here — otherwise every var() resolves to nothing and
       the text renders on a transparent background. */
    .rs-inline {
      --rs-bg: var(--color-tone-4, #f6f7f8);
      --rs-border: var(--color-tone-5, #e4e6e8);
      --rs-text: var(--color-tone-1, #1c1c1c);
      --rs-text-muted: var(--color-tone-3, #7c7c7c);
      --rs-shadow: rgba(0,0,0,0.15);
      --rs-accent: #d93a00;
      --rs-accent-soft: rgba(217,58,0,0.25);
      --rs-ok: #1a7f37;
      --rs-error: #c9252d;

      display: block;
      position: static;
      width: auto;
      max-height: none;
      overflow: visible;
      /* Opaque, not transparent: the block is nested inside the element it
         replaces, and anything of that element still painted underneath would
         otherwise show through the list. */
      background: var(--rs-bg);
      border: none;
      border-radius: 0;
      padding: 6px;
      box-shadow: none;
      z-index: auto;
      font-size: 13px;
    }
    @media (prefers-color-scheme: dark) {
      .rs-inline {
        --rs-bg: #1a1a1b;
        --rs-border: #343536;
        --rs-text: #d7dadc;
        --rs-text-muted: #818384;
        --rs-shadow: rgba(0,0,0,0.4);
        --rs-ok: #4ac26b;
        --rs-error: #ff7b72;
      }
    }
    body.theme-dark .rs-inline,
    html[data-theme="dark"] .rs-inline,
    .dark-mode .rs-inline {
      --rs-bg: #1a1a1b;
      --rs-border: #343536;
      --rs-text: #d7dadc;
      --rs-text-muted: #818384;
      --rs-shadow: rgba(0,0,0,0.4);
      --rs-ok: #4ac26b;
      --rs-error: #ff7b72;
    }
    .rs-inline-host { display: block; position: relative; }
    .rs-inline-host-replace {
      position: absolute;
      visibility: visible;
      top: 0;
      left: 0;
    }
    /* A replace target is marked with this class. visibility:hidden alone is
       not enough: it inherits, but an explicit visibility:visible on a
       DESCENDANT overrides it, and Reddit ships exactly that (a Tailwind
       "visible" class) on its login prompt — so the prompt stayed painted over
       the replacement block. Force the whole subtree hidden, then re-show our
       own block, which lives inside that subtree. */
    /* .rs-replacing * is load-bearing: !important on the ELEMENT alone does not
       beat the descendant's own visibility:visible, but a rule that matches the
       descendant does. Verified against the fixture and live reddit. */
    .rs-replacing,
    .rs-replacing * {
      visibility: hidden !important;
    }
    /* Both rules are !important, so specificity decides: this selector is more
       specific than the hide rule above, which is what re-shows our block. */
    .rs-replacing > .rs-inline-host,
    .rs-replacing > .rs-inline-host * {
      visibility: visible !important;
    }

    /* ---- Resize handle for inline blocks ---- */
    .rs-resize-handle {
      position: absolute;
      bottom: 0;
      right: 0;
      width: 10px;
      height: 10px;
      cursor: se-resize;
      opacity: 0.25;
      transition: opacity 0.15s;
      /* Hardcoded grey — visible on both light and dark backgrounds.
         CSS vars don't inherit from sibling to child, so --rs-text-muted
         is undefined here. */
      background:
        linear-gradient(135deg, transparent 0%, transparent 42%, #888 42%, #888 58%, transparent 58%),
        linear-gradient(135deg, transparent 0%, transparent 62%, #888 62%, #888 78%, transparent 78%);
      z-index: 1;
    }
    .rs-resize-handle:hover { opacity: 0.7; }

    /* The close button's role here is to drop the binding. */
    .rs-close-btn {
      margin-left: auto;
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
