import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  hasPermission,
  type BootstrapDto,
  type CoreEntity,
  type CustomFieldDef,
  type PipelineDto,
  type Scope,
  type VisibilityLevel,
} from '@app/shared';
import { ApiError, apiGet, onUnauthenticated } from '@/lib/api';
import { labelVars } from '@/lib/labels';

export const bootstrapKey = ['meta', 'bootstrap'] as const;

interface SessionValue {
  status: 'loading' | 'authenticated' | 'anonymous';
  data: BootstrapDto | null;
  refetch: () => Promise<unknown>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: bootstrapKey,
    queryFn: () => apiGet<BootstrapDto>('/meta/bootstrap'),
    retry: (count, err) =>
      !(err instanceof ApiError && (err.status === 401 || err.status === 403)) && count < 2,
    staleTime: 30_000,
  });

  useEffect(() => {
    const off = onUnauthenticated(() => {
      qc.setQueryData(bootstrapKey, null);
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'public' && q.queryKey[0] !== 'meta' });
    });
    return () => {
      off();
    };
  }, [qc]);

  const status: SessionValue['status'] = query.isPending
    ? 'loading'
    : query.data
      ? 'authenticated'
      : 'anonymous';
  const value = useMemo(
    () => ({ status, data: query.data ?? null, refetch: query.refetch }),
    [status, query.data, query.refetch],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** Bootstrap data for authenticated screens (throws if used before sign-in). */
export function useBoot(): BootstrapDto {
  const { data } = useSession();
  if (!data) throw new Error('useBoot requires an authenticated session');
  return data;
}

export function useCan() {
  const { access } = useBoot();
  return (permission: string) => access.isAdmin || hasPermission(access.permissions, permission);
}

export function useScope(resource: string): Scope {
  const { access } = useBoot();
  return access.isAdmin ? 'all' : (access.scopes[resource] ?? 'own');
}

/** Translation with entity vocabulary always in scope. */
export function useT() {
  const { t } = useTranslation();
  const { data } = useSession();
  const vars = useMemo(() => labelVars(data?.labels ?? {}), [data?.labels]);
  return useMemo(
    () =>
      (key: string, opts: Record<string, unknown> = {}) =>
        t(key, { ...vars, ...opts }) as string,
    [t, vars],
  );
}

export function useLabel(entity: string) {
  const { data } = useSession();
  const l = data?.labels[entity];
  return l ?? { singular: entity, plural: `${entity}s` };
}

export function useFields(entity: CoreEntity): (CustomFieldDef & { level: VisibilityLevel })[] {
  const { customFields } = useBoot();
  return useMemo(() => customFields.filter((f) => f.entity === entity), [customFields, entity]);
}

export function usePipelines(entity: PipelineDto['entity'] = 'deal'): PipelineDto[] {
  const { pipelines } = useBoot();
  return useMemo(() => pipelines.filter((p) => p.entity === entity), [pipelines, entity]);
}
