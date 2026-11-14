import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Trash2, Users } from 'lucide-react';
import type { RecordSharesResult } from '@app/shared';

interface TeamRef {
  uuid: string;
  name: string;
}
import { apiDelete, apiGet, apiPost } from '@/lib/api';
import { useBoot } from '@/app/session';
import { Button } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/input';
import { Avatar, ErrorState, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Combobox } from '@/components/fields/combobox';
import { useUsersPicker } from './api';

/**
 * Who else can open this record. Shares add access to this one record only; people still need
 * their role's permission for the record type.
 */
export function ShareDialog({
  route,
  uuid,
  title,
  onClose,
}: {
  route: string;
  uuid: string;
  title: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { me } = useBoot();
  const key = ['records', route, 'shares', uuid];
  const shares = useQuery({
    queryKey: key,
    queryFn: () => apiGet<RecordSharesResult>(`/${route}/${uuid}/shares`),
  });
  const teams = useQuery({
    queryKey: ['teams'],
    queryFn: () => apiGet<{ data: TeamRef[] }>('/teams').then((r) => r.data),
  });
  const [q, setQ] = useState('');
  const users = useUsersPicker(q);
  const [level, setLevel] = useState<'view' | 'edit'>('view');
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const add = useMutation({
    mutationFn: (target: { userUuid?: string; teamUuid?: string }) =>
      apiPost(`/${route}/${uuid}/shares`, { ...target, level }),
    onSuccess: () => {
      toast.success('Shared');
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (shareUuid: string) => apiDelete(`/${route}/${uuid}/shares/${shareUuid}`),
    onSuccess: () => {
      toast.success('Removed');
      refresh();
    },
  });
  const options = useMemo(
    () => [
      ...(users.data ?? [])
        .filter((u) => u.uuid !== me.uuid)
        .map((u) => ({ value: `user:${u.uuid}`, label: `${u.firstName} ${u.lastName}`.trim() || u.email })),
      ...(teams.data ?? []).map((t) => ({ value: `team:${t.uuid}`, label: `Team: ${t.name}` })),
    ],
    [users.data, teams.data, me.uuid],
  );
  const manage = shares.data?.canManage ?? false;
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={`Share “${title}”`}
        description="Give one more person or team access to this record. They still need permission for this kind of record."
        footer={<Button onClick={onClose}>Done</Button>}
      >
        {shares.isPending ? (
          <Skeleton className="h-24" />
        ) : shares.isError ? (
          <ErrorState error={shares.error} onRetry={() => void shares.refetch()} />
        ) : (
          <div className="flex flex-col gap-4">
            {manage ? (
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-48 flex-1">
                  <Combobox
                    aria-label="Person or team"
                    value={null}
                    options={options}
                    onSearch={setQ}
                    loading={users.isFetching}
                    placeholder="Add a person or team"
                    onChange={(v) => {
                      if (!v) return;
                      const [kind, id] = String(v).split(':') as ['user' | 'team', string];
                      add.mutate(kind === 'user' ? { userUuid: id } : { teamUuid: id });
                    }}
                  />
                </div>
                <NativeSelect
                  aria-label="Access"
                  value={level}
                  onChange={(e) => setLevel(e.target.value as 'view' | 'edit')}
                  className="w-32"
                >
                  <option value="view">Can view</option>
                  <option value="edit">Can edit</option>
                </NativeSelect>
              </div>
            ) : (
              <p className="text-sm text-muted">Only the owner or an admin can share this record.</p>
            )}
            {!shares.data.data.length ? (
              <p className="text-sm text-muted">Not shared with anyone yet.</p>
            ) : (
              <ul className="divide-y divide-line">
                {shares.data.data.map((s) => {
                  const name = s.user?.name ?? s.team?.name ?? 'Removed';
                  return (
                    <li key={s.uuid} className="flex items-center gap-3 py-2 text-sm">
                      {s.team ? <Users className="size-5 text-muted" /> : <Avatar name={name} size="sm" />}
                      <span className="min-w-0 flex-1 truncate">{s.team ? `Team: ${name}` : name}</span>
                      <span className="text-xs text-muted">
                        {s.level === 'edit' ? 'Can edit' : 'Can view'}
                      </span>
                      {manage || s.user?.uuid === me.uuid ? (
                        <Button
                          size="icon"
                          variant="ghost"
                          aria-label={`Stop sharing with ${name}`}
                          onClick={() => remove.mutate(s.uuid)}
                        >
                          <Trash2 />
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
