/** All TanStack Query keys in one place so invalidation stays consistent. */
export const qk = {
  list: (route: string, params?: unknown) =>
    params === undefined ? ['records', route, 'list'] : ['records', route, 'list', params],
  record: (route: string, uuid: string) => ['records', route, 'one', uuid] as const,
  records: (route: string) => ['records', route] as const,
  timeline: (route: string, uuid: string) => ['records', route, 'timeline', uuid] as const,
  activitiesFor: (type: string, uuid: string) => ['activities', 'for', type, uuid] as const,
  files: (type: string, uuid: string) => ['files', type, uuid] as const,
  board: (params: unknown) => ['records', 'deals', 'board', params] as const,
  calendar: (params: unknown) => ['activities', 'calendar', params] as const,
  users: (q = '') => ['users', 'picker', q] as const,
  tags: (q = '') => ['tags', q] as const,
  customFields: (entity?: string) => ['custom-fields', entity ?? 'all'] as const,
  pipelines: () => ['pipelines'] as const,
  views: (entity: string) => ['saved-views', entity] as const,
  consents: (entity: string, uuid: string) => ['privacy', 'consents', entity, uuid] as const,
  privacyRequests: (params?: unknown) =>
    params === undefined ? (['privacy', 'requests'] as const) : (['privacy', 'requests', params] as const),
};
