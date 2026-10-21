import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { DEFAULT_LABELS } from '@app/shared';
import { apiPut } from '@/lib/api';
import { bootstrapKey, useBoot, useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Pane } from '@/components/ui/misc';
import { SettingsPage } from './layout';

/** Rename what things are called everywhere: menus, titles, buttons, empty states and emails. */
export function VocabularyPage() {
  const t = useT();
  const { labels } = useBoot();
  const qc = useQueryClient();
  const keys = Object.keys({ ...DEFAULT_LABELS, ...labels });
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(keys.map((k) => [k, labels[k] ?? DEFAULT_LABELS[k as keyof typeof DEFAULT_LABELS]])),
  );
  const save = useMutation({
    mutationFn: () => apiPut('/labels', { locale: 'en', labels: draft }),
    onSuccess: () => {
      toast.success('Vocabulary saved');
      void qc.invalidateQueries({ queryKey: bootstrapKey });
    },
  });
  const set = (k: string, f: 'singular' | 'plural', v: string) =>
    setDraft((d) => ({ ...d, [k]: { ...d[k]!, [f]: v } }));
  return (
    <SettingsPage
      title={t('settings.vocabulary')}
      description={t('settings.vocabularyHelp')}
      actions={
        <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
          Save vocabulary
        </Button>
      }
    >
      <Pane padded={false}>
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-x-3 border-b border-line px-4 py-2 text-xs font-medium text-muted">
          <span>Default</span>
          <span>Singular</span>
          <span>Plural</span>
        </div>
        <ul className="divide-y divide-line">
          {keys.map((k) => (
            <li
              key={k}
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-3 px-4 py-2"
            >
              <span className="truncate text-sm text-muted">
                {DEFAULT_LABELS[k as keyof typeof DEFAULT_LABELS]?.singular ?? k}
              </span>
              <Input
                aria-label={`${k} singular`}
                value={draft[k]?.singular ?? ''}
                onChange={(e) => set(k, 'singular', e.target.value)}
              />
              <Input
                aria-label={`${k} plural`}
                value={draft[k]?.plural ?? ''}
                onChange={(e) => set(k, 'plural', e.target.value)}
              />
            </li>
          ))}
        </ul>
      </Pane>
    </SettingsPage>
  );
}
