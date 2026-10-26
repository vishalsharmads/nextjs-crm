import { useEffect, useLayoutEffect, useRef } from 'react';

type Handler = (e: KeyboardEvent) => void;

function isTyping(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Enter on a focused link, button or menu item activates it; a shortcut must not swallow that. */
const ACTIVATABLE =
  'a, button, [role="button"], [role="menuitem"], [role="checkbox"], [role="tab"], [role="option"]';

/**
 * Global shortcuts. Keys are single characters ("c", "/", "?") or two-key sequences ("g c").
 * "mod+k" means ⌘K on macOS and Ctrl+K elsewhere. Ignored while typing in a field.
 */
export function useHotkeys(map: Record<string, Handler>, enabled = true) {
  const mapRef = useRef(map);
  useLayoutEffect(() => {
    mapRef.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const m = mapRef.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && m['mod+k']) {
        e.preventDefault();
        m['mod+k'](e);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e)) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (key === 'Enter' && (e.target as HTMLElement | null)?.closest?.(ACTIVATABLE)) return;
      if (pending) {
        const seq = `${pending} ${key}`;
        pending = null;
        clearTimeout(timer);
        if (m[seq]) {
          e.preventDefault();
          m[seq](e);
        }
        return;
      }
      if (Object.keys(m).some((k) => k.startsWith(`${key} `))) {
        pending = key;
        timer = setTimeout(() => (pending = null), 900);
        return;
      }
      if (m[key]) {
        e.preventDefault();
        m[key](e);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(timer);
    };
  }, [enabled]);
}
