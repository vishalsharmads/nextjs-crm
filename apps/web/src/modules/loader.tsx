import { useEffect, useState, type ReactElement } from 'react';
import { Navigate, useParams, useRoutes } from 'react-router';
import type { WebModule } from '@app/module-sdk';
import { useBoot } from '@/app/session';
import { Spinner } from '@/components/ui/spinner';
import { EmptyState, ErrorState } from '@/components/ui/misc';

type Mod = WebModule<ReactElement>;

/**
 * Every module's web entry becomes its own lazy chunk at build time.
 * A module renders only when it is enabled; its menu items are already permission-filtered by the API.
 */
const entries = import.meta.glob<{ default: Mod }>('../../../../modules/*/web/index.tsx');
const loaders = new Map(
  Object.entries(entries).map(([path, load]) => [path.split('/modules/')[1]!.split('/')[0]!, load]),
);
const cache = new Map<string, Promise<Mod>>();
/** Load a module's web entry (cached). Rejects for modules not in this build. */
export const loadModule = (key: string) => {
  if (!loaders.has(key)) return Promise.reject(new Error(`Module "${key}" is not in this build`));
  if (!cache.has(key))
    cache.set(
      key,
      loaders.get(key)!().then((m) => m.default),
    );
  return cache.get(key)!;
};

function ModuleRoutes({ mod }: { mod: Mod }) {
  return useRoutes(mod.routes.map((r) => ({ path: r.path ? `${r.path}/*` : '*', element: r.element })));
}

export function ModuleOutlet() {
  const { moduleKey = '' } = useParams();
  const boot = useBoot();
  const known = loaders.has(moduleKey);
  const enabled = boot.modules.enabled.includes(moduleKey);
  const [state, setState] = useState<{ key: string; mod?: Mod; error?: unknown } | null>(null);

  useEffect(() => {
    if (!known || !enabled) return;
    let live = true;
    loadModule(moduleKey).then(
      (mod) => live && setState({ key: moduleKey, mod }),
      (error: unknown) => live && setState({ key: moduleKey, error }),
    );
    return () => {
      live = false;
    };
  }, [moduleKey, known, enabled]);

  if (!known) return <Navigate to="/" replace />;
  if (!enabled)
    return (
      <EmptyState
        title="This module is turned off"
        description="An admin can turn it on in Settings → Modules."
      />
    );
  if (state?.key === moduleKey && state.error) return <ErrorState error={state.error} />;
  if (state?.key !== moduleKey || !state.mod) {
    return (
      <div className="flex h-40 items-center justify-center text-muted">
        <Spinner />
      </div>
    );
  }
  return <ModuleRoutes mod={state.mod} />;
}

/** Renders a module's dashboard widget once its web entry has loaded. */
export function ModuleWidget({ type, data }: { type: string; data: unknown }) {
  const moduleKey = type.split('.')[0]!;
  const [mod, setMod] = useState<Mod | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    loadModule(moduleKey).then(
      (m) => live && setMod(m),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [moduleKey]);
  const Render = mod?.widgets?.[type];
  if (failed || (mod && !Render)) return <p className="text-sm text-muted">This widget is not available.</p>;
  if (!Render) return <Spinner />;
  return Render({ data });
}
