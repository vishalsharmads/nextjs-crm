import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { ConsentSummaryDto, DataSubjectEntity } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { qk } from '@/lib/query-keys';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent } from '@/components/ui/dialog';

const SOURCE: Record<string, string> = {
  form: 'Web form',
  manual: 'Recorded by staff',
  import: 'Import',
  portal: 'Client portal',
  unsubscribe: 'Unsubscribe link',
  api: 'API',
};

/** Consent per purpose, with the full history (wording, source, who recorded it). */
export function ConsentPanel({
  entity,
  uuid,
  resource,
}: {
  entity: DataSubjectEntity;
  uuid: string;
  resource: string;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const [change, setChange] = useState<{
    purposeKey: string;
    label: string;
    status: 'granted' | 'withdrawn';
  } | null>(null);
  const [note, setNote] = useState('');
  const q = useQuery({
    queryKey: qk.consents(entity, uuid),
    queryFn: () => apiGet<ConsentSummaryDto>(`/privacy/${entity}/${uuid}/consents`),
  });
  const save = useMutation({
    mutationFn: () =>
      apiPost<ConsentSummaryDto>(`/privacy/${entity}/${uuid}/consents`, {
        purposeKey: change!.purposeKey,
        status: change!.status,
        note: note || undefined,
      }),
    onSuccess: (data) => {
      qc.setQueryData(qk.consents(entity, uuid), data);
      void qc.invalidateQueries({ queryKey: ['records'] });
      toast.success(change!.status === 'granted' ? 'Consent recorded' : 'Consent withdrawn');
      setChange(null);
      setNote('');
    },
  });

  if (q.isPending) return <Skeleton className="h-32" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const data = q.data;
  const editable = can(`${resource}.update`);

  return (
    <div className="flex flex-col gap-5">
      {data.processingRestricted || data.marketingOptOut ? (
        <div className="flex flex-wrap gap-2">
          {data.processingRestricted ? <Badge tone="accent">Processing restricted</Badge> : null}
          {data.marketingOptOut ? <Badge tone="outline">Opted out of marketing</Badge> : null}
        </div>
      ) : null}
      {!data.current.length ? (
        <EmptyState
          title="No consent purposes yet"
          description="An admin adds them under Settings → Compliance. Web forms can then ask for consent."
        />
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line">
          {data.current.map((c) => (
            <li key={c.purposeKey} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="font-medium">{c.purposeLabel}</span>
              <Badge tone={c.status === 'granted' ? 'primary' : 'outline'}>
                {c.status === 'granted' ? 'Given' : c.status === 'withdrawn' ? 'Withdrawn' : 'Not asked'}
              </Badge>
              {editable ? (
                <Button
                  size="sm"
                  variant="ghost"
                  className="ms-auto"
                  onClick={() =>
                    setChange({
                      purposeKey: c.purposeKey,
                      label: c.purposeLabel,
                      status: c.status === 'granted' ? 'withdrawn' : 'granted',
                    })
                  }
                >
                  {c.status === 'granted' ? 'Withdraw' : 'Record consent'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data.history.length ? (
        <section aria-label="Consent history">
          <h3 className="mb-2 text-xs font-medium tracking-wide text-muted uppercase">History</h3>
          <ol className="flex flex-col gap-3 text-sm">
            {data.history.map((h, i) => (
              <li key={i} className="border-s-2 border-line ps-3">
                <p>
                  <span className="font-medium">{h.purposeLabel}</span>{' '}
                  {h.status === 'granted' ? 'given' : 'withdrawn'} · {SOURCE[h.source] ?? h.source}
                  {h.recordedBy ? ` · ${h.recordedBy.name}` : ''}
                </p>
                <p className="text-xs text-muted">{formatDateTime(h.createdAt)}</p>
                <blockquote className="mt-1 text-xs text-muted italic">“{h.textSnapshot}”</blockquote>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <Dialog open={change !== null} onOpenChange={(o) => !o && setChange(null)}>
        <DialogContent
          title={
            change?.status === 'granted'
              ? `Record consent: ${change.label}`
              : `Withdraw consent: ${change?.label}`
          }
          description="Record only what the person told you. The entry cannot be edited later."
          footer={
            <>
              <Button onClick={() => setChange(null)}>Cancel</Button>
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                {change?.status === 'granted' ? 'Record consent' : 'Withdraw'}
              </Button>
            </>
          }
        >
          <Field label="How did they tell you?" help="For example: phone call on 3 May, signed paper form.">
            {(p) => <Input {...p} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </DialogContent>
      </Dialog>
    </div>
  );
}
