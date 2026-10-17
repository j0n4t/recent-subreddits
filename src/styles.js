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
      /* Total width, so it matches POPUP_WIDTH in position.js — the clamp on the
         right edge is computed from that constant. */
      box-sizing: border-box;
      /* NO max-height here: position.js sets it per placement, from the room
         below or above the trigger. A fixed 70vh knew nothing about where the
         popup started, so a trigger low on the page produced a popup running
         off the bottom of the viewport. */
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
    /* The blocklist is one name per line, so it needs a textarea rather than the
       single-line input the other fields use. */
    .rs-blocked-input {
      display: block;
      resize: vertical;
      min-height: 56px;
      font-family: monospace;
      line-height: 1.5;
    }
    /* A numeric field is not clickable-to-edit the way the hotkey field is. */
    .rs-number-input {
      cursor: text;
      width: 80px;
    }
    .rs-hint {
      font-size: 11px;
      color: var(--rs-text-muted);
      margin-top: 4px;
      line-height: 1.4;
    }
    /* A checkbox setting reads as one row: box, then label. */
    .rs-check {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--rs-text);
      cursor: pointer;
    }
    .rs-checkbox {
      margin: 0;
      cursor: pointer;
      accent-color: var(--rs-accent);
    }
    /* ---- Accordion sections ---- */
    .rs-acc-section { border-top: 1px solid var(--rs-border); }
    .rs-acc-section:first-child { border-top: none; }
    .rs-acc-header {
      width: 100%;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 0;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      color: var(--rs-text-muted);
      background: none;
      border: none;
      cursor: pointer;
      text-align: left;
    }
    .rs-acc-header::after {
      content: '▾';
      font-size: 10px;
      transition: transform 0.15s;
    }
    .rs-acc-section.rs-acc-open .rs-acc-header::after { transform: rotate(180deg); }
    .rs-acc-header:hover { color: var(--rs-text); }
    .rs-acc-body { display: none; padding-bottom: 8px; }
    .rs-acc-section.rs-acc-open .rs-acc-body { display: block; }
    .rs-status {
      font-size: 11px;
      min-height: 14px;
      margin-bottom: 4px;
    }
    .rs-status-ok { color: var(--rs-ok); }
    .rs-status-error { color: var(--rs-error); }
    /* A standing condition rather than a transient message: e.g. no hook is
       configured, so the popup is hotkey-only. */
    .rs-warn {
      margin-top: 6px;
      padding: 6px 8px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--rs-text);
      background: var(--rs-accent-soft);
      border-radius: 4px;
    }

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
      /* Pinned to the bottom of the popup's scrollport. The panel is ~590px of
         content, so on a short viewport it scrolls — and Done is the way out of
         the panel, so it must not be the thing that scrolls out of reach. The
         background is required: without it the fields scroll visibly behind. */
      position: sticky;
      bottom: 0;
      background: var(--rs-bg);
      padding-top: 8px;
      margin-top: 4px;
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
    .rs-reorder-up, .rs-reorder-down {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px;
      font-size: 10px;
      line-height: 1;
      color: var(--rs-text-muted);
      opacity: 0.5;
      transition: opacity 0.15s;
    }
    .rs-reorder-up:hover, .rs-reorder-down:hover { opacity: 1; }
    .rs-reorder-up:disabled, .rs-reorder-down:disabled {
      opacity: 0.15;
      cursor: default;
    }
    /* The trash sits next to the pin and matches it, so a row's controls read as
       one group. Recent rows only — the Pinned section uses the ✕ above. */
    .rs-remove-btn {
      background: none;
      border: none;
      cursor: pointer;
      padding: 2px;
      font-size: 12px;
      /* Two things are load-bearing here, both verified by rendering the variants
         side by side on a dark background:
         - the colour must be SET. The pin gets away with inheriting because it is
           an emoji and renders in its own colours, but the trash is a monochrome
           glyph, so unset it inherits whatever the host page uses.
         - it must be the full text colour, not the muted token: as a thin outline
           glyph the muted one measured as borderline/invisible against a dark
           background. The VS16 emoji variant (which would match the pin's weight)
           is not an option — it renders as tofu on Windows.
         Hover turns it red, so the destructive action is explicit. */
      color: var(--rs-text);
      transition: color 0.15s;
    }
    .rs-remove-btn:hover { color: var(--rs-error); }
    /* ---- Opt-in: controls appear on row hover ---- */
    /* "Hide row controls" in settings puts .rs-hide-controls on the instance.
       The controls keep their place in the row (no reflow on hover) and only
       their visibility changes. Scoped to the instance class rather than the
       controls themselves, so the default look is untouched. */
    .rs-hide-controls .rs-pin-btn,
    .rs-hide-controls .rs-unpin-btn,
    .rs-hide-controls .rs-remove-btn,
    .rs-hide-controls .rs-reorder-up,
    .rs-hide-controls .rs-reorder-down {
      opacity: 0;
    }
    .rs-hide-controls .rs-item:hover .rs-pin-btn,
    .rs-hide-controls .rs-item:hover .rs-unpin-btn,
    .rs-hide-controls .rs-item:hover .rs-remove-btn,
    .rs-hide-controls .rs-item:hover .rs-reorder-up,
    .rs-hide-controls .rs-item:hover .rs-reorder-down,
    .rs-hide-controls .rs-pin-btn:focus-visible,
    .rs-hide-controls .rs-unpin-btn:focus-visible,
    .rs-hide-controls .rs-remove-btn:focus-visible,
    .rs-hide-controls .rs-reorder-up:focus-visible,
    .rs-hide-controls .rs-reorder-down:focus-visible {
      opacity: 1;
    }
    /* The main close button follows the same rule, revealed by hovering the
       header row it sits in. */
    .rs-hide-controls .rs-close-btn {
      opacity: 0;
      transition: color 0.15s, opacity 0.15s;
    }
    .rs-hide-controls .rs-header-row:hover .rs-close-btn,
    .rs-hide-controls .rs-close-btn:focus-visible {
      opacity: 1;
    }
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
