// Popup positioning
//
// Pure geometry: given a popup element and a trigger (or nothing), decide where
// the popup goes AND how tall it may be. Kept apart from the popup's state so
// the placement rules are readable on their own.
//
// Height is this module's business, not the stylesheet's. A fixed max-height
// cannot know where the popup starts, so a trigger low on the page produced a
// popup that ran off the bottom. And because the height is what the placement
// math reads, every caller that changes the popup's content has to place it
// again — see repositionPopup() in app.js.
//
// POPUP_WIDTH is the popup's TOTAL width, padding and border included: the
// stylesheet sets box-sizing: border-box for exactly this reason. Under the
// default content-box the rendered popup was 30px wider than this constant, so
// the right-edge clamp was off by the same amount.

const POPUP_WIDTH = 280;
const GAP = 8;
const MARGIN = 16;
// Below this the popup is not worth showing; better to overflow a sliver than to
// collapse it to nothing on a very short viewport.
const MIN_HEIGHT = 120;

/** The tallest the popup may ever be and still fit the viewport. */
function viewportRoom() {
  return window.innerHeight - MARGIN * 2;
}

/** Room for a popup placed below the trigger, and for one flipped above it. */
function roomAround(rect) {
  return {
    below: window.innerHeight - MARGIN - (rect.bottom + GAP),
    above: rect.top - GAP - MARGIN,
  };
}

/**
 * Cap the popup's height, then return the height it will really render at.
 *
 * The cap is applied BEFORE the read on purpose: the side choice in
 * positionPopup() has to be made against the height the popup will actually
 * have, not the natural height of its content.
 */
function capAndMeasure(popup, maxHeight) {
  popup.style.maxHeight = Math.max(MIN_HEIGHT, Math.round(maxHeight)) + 'px';
  return popup.offsetHeight;
}

/** Anchor the popup to a trigger, flipping above it when below will not do. */
export function positionPopup(popup, trigger) {
  const rect = trigger.getBoundingClientRect();
  const room = roomAround(rect);

  // Measure under the viewport-wide cap first, so the side choice below is not
  // made against a height that is about to be capped away.
  const natural = capAndMeasure(popup, viewportRoom());

  let below;
  if (room.below >= natural) below = true;        // fits below: the normal case
  else if (room.above >= natural) below = false;  // only fits above: flip
  else below = room.below >= room.above;          // fits on neither: roomier side

  // Cap to the room that side actually has, so a popup taller than its side
  // scrolls instead of running past the viewport edge.
  const side = below ? room.below : room.above;
  const height = capAndMeasure(popup, Math.min(side, viewportRoom()));

  let top = below ? rect.bottom + GAP : rect.top - GAP - height;
  // Final guard: pin it inside the viewport. The cap above normally makes this
  // a no-op; it matters when MIN_HEIGHT wins on a very short viewport, where
  // overflowing a few px beats placing the popup off-screen entirely.
  top = Math.max(MARGIN, Math.min(top, window.innerHeight - height - MARGIN));

  // Horizontal: align the left edge with the trigger, clamped to the viewport.
  let left = rect.left;
  if (left + POPUP_WIDTH > window.innerWidth - MARGIN) {
    left = window.innerWidth - POPUP_WIDTH - MARGIN;
  }
  if (left < MARGIN) left = MARGIN;

  popup.style.left = Math.round(left) + 'px';
  popup.style.top = Math.round(top) + 'px';
}

/** Centre the popup when opened by hotkey (no trigger to anchor to). */
export function positionPopupCentered(popup) {
  const height = capAndMeasure(popup, viewportRoom());

  const left = Math.max(MARGIN, Math.round((window.innerWidth - POPUP_WIDTH) / 2));
  const top = Math.max(MARGIN, Math.round((window.innerHeight - height) / 2));

  popup.style.left = left + 'px';
  popup.style.top = top + 'px';
}
