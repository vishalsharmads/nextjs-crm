/**
 * Last keyboard/pointer input, shared across this browser's tabs. The time since the last input
 * is sent with every API call (`x-idle-ms`) so the server can move its idle clock forward only for
 * real use, never for background requests such as polling and token refresh.
 */
const KEY = 'ui.lastInput';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
const pageLoadedAt = Date.now();
let lastInput = 0;
let lastShared = 0;

function share(at: number) {
  // Another tab in use keeps this one alive too. Throttled: input events are frequent.
  if (at - lastShared < 5_000) return;
  lastShared = at;
  try {
    localStorage.setItem(KEY, String(at));
  } catch {
    // Storage blocked: each tab tracks its own input.
  }
}

function sharedInput(): number {
  try {
    return Number(localStorage.getItem(KEY)) || 0;
  } catch {
    return 0;
  }
}

if (typeof window !== 'undefined') {
  const mark = () => {
    lastInput = Date.now();
    share(lastInput);
  };
  for (const e of EVENTS) window.addEventListener(e, mark, { passive: true, capture: true });
}

/** Time of the last real input in any tab, or 0 if there has been none. */
export const lastInputAt = () => Math.max(lastInput, sharedInput());

/** Value for the `x-idle-ms` header, or undefined before any input (a page load is not activity). */
export function idleHeader(): string | undefined {
  const at = lastInputAt();
  return at ? String(Math.max(0, Date.now() - at)) : undefined;
}

/** Idle time for the sign-out timer. Opening the page starts the clock. */
export const idleMs = () => Math.max(0, Date.now() - Math.max(lastInputAt(), pageLoadedAt));

/** Treat a deliberate action (for example "Stay signed in") as input. */
export function markActive() {
  lastInput = Date.now();
  lastShared = 0;
  share(lastInput);
}
