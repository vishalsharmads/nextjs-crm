import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { MergeFieldGroup, RelatedType, SavedReply } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import type { RichTextEditorProps } from './rich-text-editor';

/**
 * Saved replies for the `/` menu, rendered for the record the text is about. `onRendered` gets
 * the subject too, so an email can take it when its own subject is still empty.
 */
export function useSavedReplies(
  related: { type: RelatedType; uuid: string } | null | undefined,
  onRendered?: (r: { subject: string; html: string }) => void,
): RichTextEditorProps['replies'] {
  const q = useQuery({
    queryKey: qk.savedReplies(),
    queryFn: () => apiGet<{ data: SavedReply[] }>('/templates/replies').then((r) => r.data),
    staleTime: 60_000,
  });
  const items = q.data;
  return useMemo(
    () =>
      items
        ? {
            items,
            insert: async (reply: SavedReply) => {
              const r = await apiPost<{ subject: string; html: string }>(
                `/templates/replies/${reply.uuid}/render`,
                { related: related ?? null },
              );
              onRendered?.(r);
              return r.html;
            },
          }
        : undefined,
    [items, related, onRendered],
  );
}

/** Placeholders a template author can insert; `path` is the API route that lists them. */
export function useMergeFields(path = '/templates/fields', enabled = true) {
  return useQuery({
    queryKey: [...qk.mergeFields(), path],
    queryFn: () => apiGet<{ data: MergeFieldGroup[] }>(path).then((r) => r.data),
    staleTime: 60_000,
    enabled,
  }).data;
}
