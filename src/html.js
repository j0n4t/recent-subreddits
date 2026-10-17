// HTML helpers
//
// Small, dependency-free utilities for building HTML strings safely.

/** Escape a value for interpolation into an HTML attribute. */
export function escAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}
