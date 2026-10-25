/**
 * Last keyboard/pointer input, shared across this browser's tabs. Sent with every API call
 * (`x-idle-ms`) so the server's idle timeout ignores background requests such as polling and
 * token refresh, and read by the idle sign-out timer.
 */
const KEY = 'ui.lastInput';
const EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
let lastInput = Date.now();
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

export const idleMs = () => Math.max(0, Date.now() - Math.max(lastInput, sharedInput()));

/** Treat a deliberate action (for example "Stay signed in") as input. */
export function markActive() {
  lastInput = Date.now();
  lastShared = 0;
  share(lastInput);
}
