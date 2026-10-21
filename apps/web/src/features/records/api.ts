import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FilterNode, ListResponse } from '@app/shared';
import { api, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';

export interface ListParams {
  page: number;
  pageSize: number;
  sort?: string;
  filter?: FilterNode | null;
  q?: string;
  view?: string | null;
  trashed?: 'only';
}

export function listQuery(params: ListParams): Record<string, string | number | undefined> {
  return {
    page: params.page,
    pageSize: params.pageSize,
    sort: params.sort,
    q: params.q || undefined,
    view: params.view || undefined,
    trashed: params.trashed,
    filter: params.filter ? JSON.stringify(params.filter) : undefined,
  };
}

export function useRecordList<T>(route: string, params: ListParams) {
  return useQuery({
    queryKey: qk.list(route, params),
    queryFn: () => apiGet<ListResponse<T>>(`/${route}`, listQuery(params)),
    placeholderData: keepPreviousData,
  });
}

export function useRecord<T>(route: string, uuid: string | null | undefined) {
  return useQuery({
    queryKey: qk.record(route, uuid ?? ''),
    queryFn: () => apiGet<T>(`/${route}/${uuid}`),
    enabled: !!uuid,
  });
}

/** Mutations invalidate the entity's lists and the record itself. */
export function useRecordMutations<T extends { uuid: string }>(route: string) {
  const qc = useQueryClient();
  const touch = (uuid?: string) => {
    void qc.invalidateQueries({ queryKey: qk.list(route) });
    if (uuid) void qc.invalidateQueries({ queryKey: ['records', route, 'timeline', uuid] });
    void qc.invalidateQueries({ queryKey: ['records', 'deals', 'board'] });
  };
  return {
    create: useMutation({
      mutationFn: (input: Record<string, unknown>) => apiPost<T>(`/${route}`, input),
      onSuccess: (rec) => {
        qc.setQueryData(qk.record(route, rec.uuid), rec);
        touch();
      },
      onError: () => undefined,
    }),
    update: useMutation({
      mutationFn: ({ uuid, input }: { uuid: string; input: Record<string, unknown> }) =>
        apiPatch<T>(`/${route}/${uuid}`, input),
      // Optimistic for simple field edits: apply locally, roll back on failure.
      onMutate: async ({ uuid, input }) => {
        const key = qk.record(route, uuid);
        await qc.cancelQueries({ queryKey: key });
        const prev = qc.getQueryData<T>(key);
        if (prev && !('custom' in input)) qc.setQueryData(key, { ...prev, ...input });
        return { prev, key };
      },
      onError: (_err, _vars, context) => {
        if (context?.prev) qc.setQueryData(context.key, context.prev);
      },
      onSuccess: (rec) => {
        qc.setQueryData(qk.record(route, rec.uuid), rec);
        touch(rec.uuid);
      },
    }),
    remove: useMutation({
      mutationFn: (uuid: string) => apiDelete(`/${route}/${uuid}`),
      onSuccess: () => touch(),
    }),
    restore: useMutation({
      mutationFn: (uuid: string) => apiPost<T>(`/${route}/${uuid}/restore`),
      onSuccess: (rec) => {
        qc.setQueryData(qk.record(route, rec.uuid), rec);
        touch(rec.uuid);
      },
    }),
  };
}

export function useUsersPicker(q = '') {
  return useQuery({
    queryKey: qk.users(q),
    queryFn: () =>
      apiGet<{
        data: { uuid: string; firstName: string; lastName: string; email: string; status: string }[];
      }>('/users', { q, pageSize: 50, status: 'active' }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useTags(q = '') {
  return useQuery({
    queryKey: qk.tags(q),
    queryFn: () =>
      apiGet<{ data: { uuid: string; name: string; slug: string; color: string | null; usage: number }[] }>(
        '/tags',
        { q },
      ).then((r) => r.data),
    staleTime: 30_000,
  });
}

export { api };
