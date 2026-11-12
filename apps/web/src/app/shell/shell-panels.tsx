import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { X } from 'lucide-react';
import { ENTITY_ROUTE, recordTypePath } from '@app/shared';
import { useBoot } from '@/app/session';
import { basePath } from '@/lib/app-url';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Sheet } from '@/components/ui/dialog';
import { ModulePanel } from '@/modules/loader';
import { moduleIcon } from './nav';

const UUID = /^[0-9a-f-]{36}$/;

/**
 * What is on screen, as ids only: a record (`/deals/<uuid>`, `/o/<object>/<uuid>`,
 * `/m/<module>/<route>/<uuid>`) or a list of one type (`/deals`). Empty elsewhere. Panels fetch
 * details themselves, with the person's permissions.
 */
function usePageOnScreen(): { entity: string; uuid: string } {
  const { pathname } = useLocation();
  const boot = useBoot();
  const path = (basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname)
    .replace(/^\//, '')
    .replace(/\/$/, '');
  const parts = path.split('/');
  const last = parts.at(-1) ?? '';
  const isRecord = UUID.test(last);
  const base = isRecord ? parts.slice(0, -1).join('/') : path;
  const core = Object.entries(ENTITY_ROUTE).find(([, route]) => route === base)?.[0];
  const entity = core ?? boot.recordTypes.find((t) => recordTypePath(t) === base)?.entity ?? '';
  return entity ? { entity, uuid: isRecord ? last : '' } : { entity: '', uuid: '' };
}

const WIDTH_KEY = 'shell-panel-width';
const OPEN_KEY = 'shell-panel-open';
const MIN_WIDTH = 320;
/** The page beside the panel keeps at least this much room. */
const MIN_PAGE = 520;
const maxWidth = () => {
  const start = document.querySelector('main')?.getBoundingClientRect().left ?? 0;
  return Math.max(MIN_WIDTH, Math.min(760, Math.round(window.innerWidth - start - MIN_PAGE)));
};
const clamp = (w: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(w)));

/** Per-viewer conveniences only (which panel was open, how wide); never anything that matters. */
function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage can be blocked; the panel still works for this visit.
  }
}

interface PanelState {
  open: string | null;
  toggle: (id: string) => void;
  close: () => void;
}
const PanelContext = createContext<PanelState>({ open: null, toggle: () => {}, close: () => {} });

/**
 * Which side panel is open. It stays open while people move around the app, and comes back after
 * a reload, so the assistant can follow along with the work.
 */
export function PanelProvider({ children }: { children: ReactNode }) {
  const panels = useBoot().modules.shellPanels ?? [];
  const [open, setOpen] = useState<string | null>(() => readStored(OPEN_KEY));
  const known = open && panels.some((p) => `${p.moduleKey}.${p.key}` === open) ? open : null;
  const toggle = useCallback((id: string) => {
    setOpen((o) => {
      const next = o === id ? null : id;
      writeStored(OPEN_KEY, next);
      return next;
    });
  }, []);
  const close = useCallback(() => {
    writeStored(OPEN_KEY, null);
    setOpen(null);
  }, []);
  return <PanelContext.Provider value={{ open: known, toggle, close }}>{children}</PanelContext.Provider>;
}

/** A module's own page already shows what its panel would, so the panel steps aside there. */
function useOnModulePage() {
  const { pathname } = useLocation();
  const here = (
    basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) : pathname
  ).replace(/^\//, '');
  return (moduleKey: string) => here === `m/${moduleKey}` || here.startsWith(`m/${moduleKey}/`);
}

/** Top-bar buttons that open and close module side panels (for example the assistant). */
export function ShellPanels() {
  const panels = useBoot().modules.shellPanels ?? [];
  const { open, toggle } = useContext(PanelContext);
  const onOwnPage = useOnModulePage();
  return (
    <>
      {panels.map((p) => {
        const id = `${p.moduleKey}.${p.key}`;
        const Icon = moduleIcon(p.icon);
        // On the module's own page the panel is not shown, so neither is the button as on.
        const shown = open === id && !onOwnPage(p.moduleKey);
        return (
          <Button
            key={id}
            variant={shown ? 'subtle' : 'ghost'}
            size="icon"
            aria-label={p.title}
            aria-pressed={shown}
            aria-controls="shell-panel"
            title={p.title}
            onClick={() => toggle(id)}
          >
            <Icon />
          </Button>
        );
      })}
    </>
  );
}

const useWide = () => {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? true);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
};

/**
 * The open side panel, docked beside the page on wide screens (the page stays usable and the panel
 * survives navigation) with a drag and keyboard resize handle; a sheet on small screens.
 */
export function DockedPanel() {
  const panels = useBoot().modules.shellPanels ?? [];
  const { open, close } = useContext(PanelContext);
  const page = usePageOnScreen();
  const wide = useWide();
  const [width, setWidth] = useState(() => clamp(Number(readStored(WIDTH_KEY)) || 420));
  const drag = useRef<{ startX: number; startW: number; rtl: boolean } | null>(null);
  const onOwnPage = useOnModulePage();
  const active = panels.find((p) => `${p.moduleKey}.${p.key}` === open && !onOwnPage(p.moduleKey));

  const commit = (w: number) => {
    const next = clamp(w);
    setWidth(next);
    writeStored(WIDTH_KEY, String(next));
  };
  // Keep the panel inside the window when it shrinks.
  useEffect(() => {
    const fit = () => setWidth((w) => clamp(w));
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  if (!active) return null;
  const body = (
    <ModulePanel moduleKey={active.moduleKey} panelKey={active.key} entity={page.entity} uuid={page.uuid} />
  );
  if (!wide)
    return (
      <Sheet open onOpenChange={(o) => !o && close()} title={active.title} width="max-w-lg">
        <div className="flex h-full min-h-0 flex-col p-4">{body}</div>
      </Sheet>
    );

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      startX: e.clientX,
      startW: width,
      rtl: getComputedStyle(e.currentTarget).direction === 'rtl',
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    // The handle is on the panel's inline-start edge: moving it away from the panel widens it.
    const delta = d.rtl ? e.clientX - d.startX : d.startX - e.clientX;
    setWidth(clamp(d.startW + delta));
  };
  const onPointerUp = () => {
    if (drag.current) commit(width);
    drag.current = null;
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 64 : 16;
    const rtl = getComputedStyle(e.currentTarget).direction === 'rtl';
    const grow = rtl ? 'ArrowRight' : 'ArrowLeft';
    const shrink = rtl ? 'ArrowLeft' : 'ArrowRight';
    if (e.key === grow) commit(width + step);
    else if (e.key === shrink) commit(width - step);
    else if (e.key === 'Home') commit(MIN_WIDTH);
    else if (e.key === 'End') commit(maxWidth());
    else return;
    e.preventDefault();
  };

  return (
    <aside
      id="shell-panel"
      aria-label={active.title}
      className="relative flex shrink-0 flex-col border-s border-line bg-surface print:hidden"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${active.title}`}
        aria-valuenow={width}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKeyDown}
        onDoubleClick={() => commit(420)}
        className={cn(
          'group absolute inset-y-0 -start-1.5 z-10 w-3 cursor-col-resize touch-none outline-none',
          'focus-visible:bg-primary-soft',
        )}
      >
        <span
          className="absolute inset-y-0 start-1.5 w-px bg-transparent transition-colors duration-150 group-hover:bg-primary group-focus-visible:bg-primary"
          aria-hidden
        />
      </div>
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-line px-4">
        <h2 className="truncate text-sm font-semibold">{active.title}</h2>
        <Button variant="ghost" size="icon-sm" aria-label={`Close ${active.title}`} onClick={close}>
          <X />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col p-4">{body}</div>
    </aside>
  );
}
