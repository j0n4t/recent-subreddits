// Selector builder
//
// Turn a picked element into a selector that survives a re-render as well as it
// can. Priority: a stable id, then a data-testid, then an nth-of-type path.
// Classes are deliberately NOT used alone — Reddit's build hashes them and they
// change between deploys, which is the whole reason this feature exists.

export function cssEscape(value) {
  const s = String(value);
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
  return s.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
}

function isUnique(selector) {
  try {
    return document.querySelectorAll(selector).length === 1;
  } catch {
    return false;
  }
}

/** A selector for `el`, preferring whatever is least likely to break. */
export function buildSelector(el) {
  if (!el || el.nodeType !== 1) return '';

  // 1. A usable id (auto-generated ids like ":r1:" are not stable).
  if (el.id && isUnique('#' + cssEscape(el.id))) {
    const id = '#' + cssEscape(el.id);
    if (id.length < 80) return id;
  }

  // 2. A test id — Reddit keeps these stable across builds.
  const testId = el.getAttribute('data-testid');
  if (testId) {
    const sel = `[data-testid="${cssEscape(testId)}"]`;
    if (isUnique(sel)) return sel;
  }

  // 3. An nth-of-type path, shortened by the nearest unique ancestor.
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let part = node.tagName.toLowerCase();
    const parent = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(node) + 1})`;
    }
    parts.unshift(part);

    const candidate = parts.join(' > ');
    // Stop as soon as the tail is unique on its own — keeps it short.
    if (isUnique(candidate)) return candidate;
    node = parent;
  }

  return parts.join(' > ');
}
