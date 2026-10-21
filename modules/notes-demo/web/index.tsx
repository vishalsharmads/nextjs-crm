import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import type { WebModule } from '@app/module-sdk';
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/input';
import { EmptyState, PageHeader, Pane } from '@/components/ui/misc';

interface Note {
  uuid: string;
  title: string;
  body: string | null;
}

function NotesPage() {
  const can = useCan();
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const notes = useQuery({
    queryKey: ['m', 'notes-demo'],
    queryFn: () => apiGet<{ data: Note[] }>('/m/notes-demo/notes').then((r) => r.data),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['m', 'notes-demo'] });
  const create = useMutation({
    mutationFn: () => apiPost('/m/notes-demo/notes', { title, body }),
    onSuccess: () => {
      setTitle('');
      setBody('');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/m/notes-demo/notes/${uuid}`),
    onSuccess: refresh,
  });
  const manage = can('notes-demo.notes.manage');
  return (
    <div>
      <PageHeader title="Pinned notes" description="Short notes everyone in the workspace can see." />
      <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 md:p-6">
        {manage ? (
          <Pane>
            <form
              className="flex flex-col gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (title.trim()) create.mutate();
              }}
            >
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Title"
                aria-label="Title"
              />
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Note"
                aria-label="Note"
              />
              <div className="flex justify-end">
                <Button type="submit" variant="primary" disabled={!title.trim()} loading={create.isPending}>
                  Pin note
                </Button>
              </div>
            </form>
          </Pane>
        ) : null}
        {notes.data?.length ? (
          <ul className="flex flex-col gap-2">
            {notes.data.map((n) => (
              <li
                key={n.uuid}
                className="flex items-start gap-3 rounded-md border border-line bg-surface p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{n.title}</p>
                  {n.body ? <p className="mt-1 text-sm whitespace-pre-wrap text-muted">{n.body}</p> : null}
                </div>
                {manage ? (
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Delete ${n.title}`}
                    onClick={() => remove.mutate(n.uuid)}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No pinned notes" description={manage ? 'Pin the first one above.' : undefined} />
        )}
      </div>
    </div>
  );
}

const notesModule: WebModule = {
  key: 'notes-demo',
  routes: [{ path: '', element: <NotesPage /> }],
};

export default notesModule;
