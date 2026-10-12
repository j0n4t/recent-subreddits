// Element picker
//
// A live overlay: hovering the page outlines the element under the cursor, and
// clicking it hands its selector back. The overlay swallows the click so the
// host page never sees it (no navigation, no Reddit handler firing).
import { buildSelector } from './selector.js';

const PICKER_STYLE_ID = 'rs-picker-styles';

let pickerActive = false;
let pickerBox = null;
let pickerHovered = null;
let pickerOnPick = null;
let pickerOnEnd = null;

function pickerHintEl() {
  return document.getElementById('rs-picker-hint');
}

function pickerCleanup() {
  const hint = pickerHintEl();
  if (hint) hint.remove();
  document.removeEventListener('mousemove', pickerMove, true);
  document.removeEventListener('click', pickerClick, true);
  document.removeEventListener('keydown', pickerKey, true);
  document.removeEventListener('scroll', pickerMove, true);
  if (pickerBox) {
    pickerBox.remove();
    pickerBox = null;
  }
  pickerActive = false;
  if (pickerOnEnd) {
    const done = pickerOnEnd;
    pickerOnEnd = null;
    done();
  }
}

function pickerMove(e) {
  if (!pickerActive) return;
  const el = /** @type {Element} */ (e.target);
  if (!el || el.nodeType !== 1) return;
  // Never target our own chrome: the popup, an inline block, or the picker hint.
  if (el.closest('#rs-popup, .rs-inline-host, #rs-picker-hint')) return;

  pickerHovered = el;
  const rect = el.getBoundingClientRect();
  const box = pickerBox;
  box.style.display = 'block';
  box.style.top = rect.top + 'px';
  box.style.left = rect.left + 'px';
  box.style.width = rect.width + 'px';
  box.style.height = rect.height + 'px';

  const hint = pickerHintEl();
  if (hint) {
    hint.textContent = `${buildSelector(el)}  —  click to use, Esc to cancel`;
  }
}

function pickerClick(e) {
  if (!pickerActive) return;
  // Swallow the click: the host must not act on a pick.
  e.preventDefault();
  e.stopPropagation();
  const el = pickerHovered;
  const selector = el ? buildSelector(el) : '';
  const onPick = pickerOnPick;
  pickerCleanup();
  if (selector && onPick) onPick(selector);
}

function pickerKey(e) {
  if (!pickerActive) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    pickerCleanup();
  }
}

/** Start picking. `onPick(selector)` fires on a click, `onEnd()` on any exit. */
export function startPicker(onPick, onEnd) {
  if (pickerActive) pickerCleanup();

  if (!document.getElementById(PICKER_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = PICKER_STYLE_ID;
    style.textContent = `
      #rs-picker-box {
        position: fixed;
        z-index: 2147483646;
        pointer-events: none;
        /* border-box: the 2px border must not inflate the box past the
           element's rect, or the outline sits 4px off the element it marks. */
        box-sizing: border-box;
        border: 2px solid #d93a00;
        background: rgba(217,58,0,0.12);
        border-radius: 2px;
        display: none;
      }
      #rs-picker-hint {
        position: fixed;
        z-index: 2147483647;
        left: 50%;
        bottom: 16px;
        transform: translateX(-50%);
        max-width: 90vw;
        padding: 6px 12px;
        font: 12px/1.4 monospace;
        color: #fff;
        background: rgba(0,0,0,0.85);
        border-radius: 4px;
        pointer-events: none;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `;
    document.head.appendChild(style);
  }

  const box = document.createElement('div');
  box.id = 'rs-picker-box';
  document.body.appendChild(box);

  const hint = document.createElement('div');
  hint.id = 'rs-picker-hint';
  hint.textContent = 'Hover an element and click it — Esc to cancel';
  document.body.appendChild(hint);

  pickerBox = box;
  pickerHovered = null;
  pickerOnPick = onPick;
  pickerOnEnd = onEnd;
  pickerActive = true;

  // Capture phase so the host's own handlers never see the pick.
  document.addEventListener('mousemove', pickerMove, true);
  document.addEventListener('click', pickerClick, true);
  document.addEventListener('keydown', pickerKey, true);
  document.addEventListener('scroll', pickerMove, true);
}
