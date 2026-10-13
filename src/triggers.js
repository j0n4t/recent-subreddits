// Trigger resolution
//
// Deciding whether an event landed on something that should open the popup.
// Every trigger is a settings entry: the built-in Reddit logo/menu selector ships
// as a default entry (see defaults.js) rather than as a hardcoded fallback, so it
// can be inspected, edited, and deleted like anything else. With no hook
// configured there is nothing here to match, and the popup opens by hotkey only.
import { hookTargets } from './storage.js';

/**
 * Resolve an event target to `{el, events}` if it is a popup trigger, else null.
 * `events` is 'hover' | 'click' | 'both'.
 */
export function resolveTrigger(target) {
  if (!target || typeof target.closest !== 'function') return null;

  for (const t of hookTargets()) {
    let el;
    try {
      el = target.closest(t.selector);
    } catch {
      // A selector the user typed by hand may be invalid — ignore it.
      continue;
    }
    if (el) return { el, events: t.events };
  }

  return null;
}

export const wantsHover = (events) => events === 'hover' || events === 'both';
export const wantsClick = (events) => events === 'click' || events === 'both';
