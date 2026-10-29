import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation } from 'react-router';
import { CircleHelp } from 'lucide-react';
import { basePath } from '@/lib/app-url';
import { Button } from '@/components/ui/button';

interface HelpContextValue {
  /** Open help for an article, or for the page on screen when no id is given. */
  open(id?: string): void;
}

const HelpContext = createContext<HelpContextValue | null>(null);

export function useHelp(): HelpContextValue {
  return useContext(HelpContext) ?? { open: () => undefined };
}

const pathOnScreen = (pathname: string) =>
  basePath && pathname.startsWith(basePath) ? pathname.slice(basePath.length) || '/' : pathname;

/** The help sheet and every article load on first use, so pages carry none of it. */
const HelpSheet = lazy(() => import('./help-sheet').then((m) => ({ default: m.HelpSheet })));

export function HelpProvider({ children, onShortcuts }: { children: ReactNode; onShortcuts: () => void }) {
  const [state, setState] = useState<{ id?: string; path: string } | null>(null);
  const location = useLocation();
  const open = useCallback(
    (id?: string) => setState({ ...(id ? { id } : {}), path: pathOnScreen(location.pathname) }),
    [location.pathname],
  );
  const value = useMemo(() => ({ open }), [open]);
  return (
    <HelpContext.Provider value={value}>
      {children}
      {state ? (
        <Suspense fallback={null}>
          <HelpSheet
            id={state.id}
            path={state.path}
            onNavigate={(id) => setState({ id, path: state.path })}
            onClose={() => setState(null)}
            onShortcuts={() => {
              setState(null);
              onShortcuts();
            }}
          />
        </Suspense>
      ) : null}
    </HelpContext.Provider>
  );
}

/** The ⓘ button in page headers: help for this page. */
export function HelpButton({ id }: { id?: string | undefined }) {
  const help = useContext(HelpContext);
  // Outside the app shell (public pages, sign-in) there is no help to open.
  if (!help) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label="Help for this page"
      data-tour="help"
      title="Help (?)"
      onClick={() => help.open(id)}
    >
      <CircleHelp />
    </Button>
  );
}
