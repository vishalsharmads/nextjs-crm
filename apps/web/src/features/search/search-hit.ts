import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { DEFAULT_LABELS } from '@app/shared';
import { useLabels } from '@/app/session';

export interface SearchHit {
  type: string;
  uuid: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  score: number;
  /** The custom field the match was found in. */
  matched?: string;
}

export function useSearch(q: string, opts: { limit?: number; enabled?: boolean } = {}) {
  const limit = opts.limit ?? 5;
  return useQuery({
    queryKey: ['search', q, limit],
    queryFn: () =>
      apiGet<{ data: SearchHit[] }>(`/search?q=${encodeURIComponent(q)}&limit=${limit}`).then((r) => r.data),
    enabled: (opts.enabled ?? true) && q.length >= 2,
    staleTime: 10_000,
    placeholderData: (prev) => prev,
  });
}

/** The workspace's name for a hit's record type ("Member", not "contact"). */
export function useTypeName() {
  const labels = useLabels();
  return (type: string, plural = false) => {
    const l = labels[type] ?? (DEFAULT_LABELS as Record<string, { singular: string; plural: string }>)[type];
    if (!l) return type;
    return plural ? l.plural : l.singular;
  };
}
