import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiPost } from '@/lib/api';
import { bootstrapKey, useBoot, useCan } from '@/app/session';
import { labelVars } from '@/lib/labels';
import { Button } from '@/components/ui/button';
import { TOURS, type Tour } from '@/help/tours';

interface TourContextValue {
  /** Tours this person may take. */
  tours: Tour[];
  start(id: string): void;
}

const TourContext = createContext<TourContextValue>({ tours: [], start: () => undefined });
export const useTours = () => useContext(TourContext);

const fill = (text: string, vars: Record<string, string>) =>
  text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (m, k: string) => vars[k] ?? m);

/** How long to wait for a step's element (a page may still be loading) before skipping it. */
const FIND_MS = 2500;

export function TourProvider({ children }: { children: ReactNode }) {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const tours = useMemo(() => TOURS.filter((t) => !t.permission || can(t.permission)), [can]);
  const [active, setActive] = useState<{ tour: Tour; step: number } | null>(null);
  const offered = useRef(false);

  const finish = useCallback(
    (tour: Tour) => {
      setActive(null);
      void apiPost(`/me/tours/${tour.id}/seen`)
        .then(() => qc.invalidateQueries({ queryKey: bootstrapKey }))
        .catch(() => undefined);
    },
    [qc],
  );
  const start = useCallback(
    (id: string) => {
      const tour = tours.find((t) => t.id === id);
      if (!tour) return;
      if (location.pathname !== tour.route) navigate(tour.route);
      setActive({ tour, step: 0 });
    },
    [tours, location.pathname, navigate],
  );

  // Offer the welcome tour once, on the home page, without getting in the way: a message with a
  // button. Dismissing it counts as seen.
  useEffect(() => {
    if (offered.current || active || location.pathname !== '/') return;
    if ((boot.me.toursSeen ?? []).includes('welcome')) return;
    offered.current = true;
    const welcome = tours.find((t) => t.id === 'welcome');
    if (!welcome) return;
    toast('New here? Take a one-minute tour.', {
      duration: 15_000,
      action: { label: 'Start the tour', onClick: () => start('welcome') },
      onDismiss: () => finish(welcome),
    });
  }, [active, boot.me.toursSeen, location.pathname, start, finish, tours]);

  const value = useMemo(() => ({ tours, start }), [tours, start]);
  return (
    <TourContext.Provider value={value}>
      {children}
      {active ? (
        <TourStepView
          key={`${active.tour.id}.${active.step}`}
          tour={active.tour}
          index={active.step}
          vars={labelVars(boot.labels)}
          onMove={(step) =>
            step >= active.tour.steps.length
              ? finish(active.tour)
              : setActive({ tour: active.tour, step: Math.max(0, step) })
          }
          onClose={() => finish(active.tour)}
        />
      ) : null}
    </TourContext.Provider>
  );
}

function TourStepView({
  tour,
  index,
  vars,
  onMove,
  onClose,
}: {
  tour: Tour;
  index: number;
  vars: Record<string, string>;
  onMove: (step: number) => void;
  onClose: () => void;
}) {
  const step = tour.steps[index]!;
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);

  // Find the step's element (waiting for the page), keep its box current, or skip the step.
  useLayoutEffect(() => {
    const started = Date.now();
    let frame = 0;
    let seen = false;
    const find = () => {
      const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
      if (el && el.getClientRects().length) {
        if (!seen) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
        seen = true;
        const r = el.getBoundingClientRect();
        // Only re-render when the element moved (scroll, resize, layout).
        setRect((prev) =>
          prev &&
          prev.top === r.top &&
          prev.left === r.left &&
          prev.width === r.width &&
          prev.height === r.height
            ? prev
            : r,
        );
      } else if (seen) {
        // The element went away (a dialog closed, the page changed): move on.
        return onMove(index + 1);
      } else if (Date.now() - started > FIND_MS) return onMove(index + 1);
      frame = requestAnimationFrame(find);
    };
    find();
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-run per step only
  }, [step.target]);

  useEffect(() => {
    card.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowRight') onMove(index + 1);
      else if (e.key === 'ArrowLeft' && index > 0) onMove(index - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, onClose, onMove]);

  if (!rect) return null;
  const pad = 6;
  const below = rect.bottom + 180 < window.innerHeight;
  const left = Math.min(Math.max(12, rect.left), window.innerWidth - 332);
  return createPortal(
    <div className="fixed inset-0 z-[60]" aria-live="polite">
      {/* The highlight: a ring around the element, the rest of the page dimmed. */}
      <div
        className="pointer-events-none fixed rounded-md ring-2 ring-primary"
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
          boxShadow: '0 0 0 9999px var(--overlay)',
        }}
      />
      <div
        ref={card}
        role="dialog"
        aria-modal="true"
        aria-label={fill(step.title, vars)}
        tabIndex={-1}
        className="anim-pop fixed w-80 rounded-lg border border-line bg-surface p-4 shadow-overlay outline-none"
        style={below ? { top: rect.bottom + 12, left } : { top: Math.max(12, rect.top - 172), left }}
      >
        <p className="text-xs text-faint">
          {fill(tour.title, vars)} · {index + 1} of {tour.steps.length}
        </p>
        <h2 className="mt-1 text-sm font-semibold">{fill(step.title, vars)}</h2>
        <p className="mt-1 text-sm text-muted">{fill(step.body, vars)}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>
            Skip tour
          </Button>
          <div className="ms-auto flex gap-2">
            {index > 0 ? (
              <Button size="sm" onClick={() => onMove(index - 1)}>
                Back
              </Button>
            ) : null}
            <Button size="sm" variant="primary" onClick={() => onMove(index + 1)}>
              {index === tour.steps.length - 1 ? 'Done' : 'Next'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
