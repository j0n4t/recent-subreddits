// Popup positioning
//
// Pure geometry: given a popup element and a trigger (or nothing), decide where
// the popup goes. Kept apart from the popup's state so the placement rules are
// readable on their own.

const POPUP_WIDTH = 280;
const GAP = 8;
const MARGIN = 16;

/** Anchor the popup to a trigger, flipping above it when there is no room below. */
export function positionPopup(popup, trigger) {
  const rect = trigger.getBoundingClientRect();
  const popupHeight = popup.offsetHeight || 300;

  // Horizontal: align left edge with trigger, clamp to viewport
  let left = rect.left;
  if (left + POPUP_WIDTH > window.innerWidth - MARGIN) {
    left = window.innerWidth - POPUP_WIDTH - MARGIN;
  }
  if (left < MARGIN) left = MARGIN;

  // Vertical: prefer below trigger, flip above if not enough space
  let top = rect.bottom + GAP;
  if (top + popupHeight > window.innerHeight - MARGIN) {
    const aboveTop = rect.top - popupHeight - GAP;
    if (aboveTop >= MARGIN) {
      top = aboveTop;
    } else {
      // Neither fits — clamp to viewport with margin
      top = Math.max(MARGIN, Math.min(top, window.innerHeight - popupHeight - MARGIN));
    }
  }

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}

/** Centre the popup when opened by hotkey (no trigger to anchor to). */
export function positionPopupCentered(popup) {
  const height = popup.offsetHeight || 300;

  const left = Math.max(MARGIN, Math.round((window.innerWidth - POPUP_WIDTH) / 2));
  const top = Math.max(MARGIN, Math.round((window.innerHeight - height) / 2));

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}
