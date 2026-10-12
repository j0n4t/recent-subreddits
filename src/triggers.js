// Trigger resolution
//
// Deciding whether an event landed on something that should open the popup.
// A user-configured hook wins over the built-in Reddit selectors, so the user's
// own event choice applies to the element they picked.
import { hookTargets } from './storage.js';
import { TRIGGER_SELECTOR } from './diagnostics.js';

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

  const builtin = target.closest(TRIGGER_SELECTOR);
  // The stock logo triggers keep the original behaviour: hover and click.
  if (builtin) return { el: builtin, events: 'both' };

  return null;
}

export const wantsHover = (events) => events === 'hover' || events === 'both';
export const wantsClick = (events) => events === 'click' || events === 'both';
