// Hotkey parsing
//
// Stored as a human-readable string ("Alt+Shift+R") because that is what a
// settings field and a bug report can carry. Parsed once, on keydown.

// ---------- Hotkey parsing ----------
// Stored as a human-readable string ("Alt+Shift+R") because that is what a
// settings field and a bug report can carry. Parsed once, on keydown.
export function parseHotkey(str) {
  const parts = String(str).split('+').map((p) => p.trim()).filter(Boolean);
  const combo = { ctrl: false, alt: false, shift: false, meta: false, key: null };

  for (const part of parts) {
    const p = part.toLowerCase();
    if (p === 'ctrl' || p === 'control') combo.ctrl = true;
    else if (p === 'alt' || p === 'option') combo.alt = true;
    else if (p === 'shift') combo.shift = true;
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') combo.meta = true;
    else combo.key = p;
  }

  // A bare modifier is not a shortcut.
  return combo.key ? combo : null;
}

export function hotkeyMatches(event, combo) {
  if (!combo) return false;
  if (event.ctrlKey !== combo.ctrl) return false;
  if (event.altKey !== combo.alt) return false;
  if (event.shiftKey !== combo.shift) return false;
  if (event.metaKey !== combo.meta) return false;
  // event.key for a letter is case-sensitive ('R' when shift is held).
  return String(event.key).toLowerCase() === combo.key;
}

// Turn a keydown into a stored combo string, or null if only modifiers are down.
export function comboFromEvent(event) {
  const key = event.key;
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');

  // Prefer a printable label: 'r' -> 'R', 'ArrowUp' -> 'ArrowUp'.
  const label = key.length === 1 ? key.toUpperCase() : key;
  parts.push(label);
  return parts.join('+');
}
