// Inline instances (replace / prepend / append)
//
// Each inline target gets a full instance of the UI — header, list, settings —
// built from the same shell as the popup, minus the popup-only chrome. The
// block is inserted NEXT TO the picked element rather than inside it, and the
// element is hidden with visibility (not display/remove) so the host's own
// layout, event handlers and framework references stay intact.
import { loadData, loadSettings, saveSettings } from './storage.js';

// The shell surface this layer calls back into, installed once by initInline().
let ctl = null;

/** Install the shell callbacks. Call once, before applyTargets(). */
export function initInline(shellCtl) {
  ctl = shellCtl;
}

/** Re-render the list inside every mounted inline block. */
export function refreshInline(data) {
  for (const rec of inlineInstances.values()) {
    if (!document.body.contains(rec.host)) continue;
    ctl.render(data, rec.host.querySelector('.rs-inline'));
  }
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
  const inst = ctl.buildPopupShell();

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
    // `promoted` records a position we set ourselves, so teardown only undoes
    // our own change and never a value the page owns.
    let promoted = false;
    if (mode === 'replace') {
      // The host is position:absolute, so it resolves against the nearest
      // POSITIONED ancestor — and the picked element is usually static, as are
      // its ancestors. Without this the block lands at the page origin while
      // the element it replaced sits hidden somewhere else.
      if (getComputedStyle(el).position === 'static') {
        el.style.position = 'relative';
        promoted = true;
      }
      // Hide the element's whole subtree via a class on the element itself.
      // visibility:hidden inherits, but an explicit visibility:visible on a
      // descendant overrides it — and Reddit ships such a class (Tailwind
      // "visible") on its login prompt, so the prompt stayed painted over the
      // block. One class + an !important rule beats walking every child.
      el.classList.add('rs-replacing');
      // Nest inside the element and overlap it — avoids leaving a gap
      // in the document flow where the hidden element used to be.
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

    rec = { el, host, mode, promoted };
    inlineInstances.set(selector, rec);
    wireInlineInstance(rec, target);
  }

  ctl.render(loadData(), rec.host.querySelector('.rs-inline'));
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
      ctl.togglePin(pin.dataset.name);
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
      ctl.setSettingsOpen(false, inst);
      return;
    }
    if (e.target.closest('.rs-settings-btn')) {
      e.stopPropagation();
      ctl.setSettingsOpen(!inst.classList.contains('settings-open'), inst);
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
export function applyTargets() {
  if (!document.body) return;
  const wanted = loadSettings().targets.filter((t) => INLINE_MODES.includes(t.mode));

  // Tear down instances whose target is gone or whose mode left the inline set.
  for (const [selector, rec] of Array.from(inlineInstances.entries())) {
    const stillWanted = wanted.some((t) => t.selector === selector);
    if (!stillWanted) {
      // Drop the marker that hid the element's subtree.
      if (rec.el) rec.el.classList.remove('rs-replacing');
      // Drop a containing block we established, but only ours — an element the
      // page positioned itself must keep its value.
      if (rec.promoted && rec.el) rec.el.style.position = '';
      rec.host.remove();
      inlineInstances.delete(selector);
    }
  }

  for (const t of wanted) mountInlineInstance(t);
}
