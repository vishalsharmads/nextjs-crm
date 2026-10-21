import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { RelatedType } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Sheet } from '@/components/ui/dialog';

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Write an email to a record's address; it is sent and logged on the record's timeline. */
export function ComposeEmail({
  to,
  related,
  onClose,
}: {
  to: string;
  related: { type: RelatedType; uuid: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => apiGet<{ data: { uuid: string; email: string }[] }>('/email/accounts').then((r) => r.data),
  });
  const [recipients, setRecipients] = useState(to);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [account, setAccount] = useState<string>('');
  const send = useMutation({
    mutationFn: () =>
      apiPost('/email/send', {
        to: recipients.split(/[,;\s]+/).filter(Boolean),
        subject,
        body: body
          .split(/\n{2,}/)
          .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
          .join(''),
        related,
        accountUuid: account || null,
      }),
    onSuccess: () => {
      toast.success('Email sent');
      void qc.invalidateQueries({ queryKey: ['records'] });
      void qc.invalidateQueries({ queryKey: ['activities'] });
      onClose();
    },
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title="New email"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => send.mutate()}
            loading={send.isPending}
            disabled={!recipients.trim() || !subject.trim() || !body.trim()}
          >
            Send email
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-5">
        {accounts.data?.length ? (
          <Field label="From">
            {(p) => (
              <NativeSelect {...p} value={account} onChange={(e) => setAccount(e.target.value)}>
                {accounts.data.map((a) => (
                  <option key={a.uuid} value={a.uuid}>
                    {a.email}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
        ) : (
          <p className="text-xs text-muted">
            Sent from the workspace address; replies go to you. Connect your mailbox in Settings → Email to
            send as yourself.
          </p>
        )}
        <Field label="To">
          {(p) => <Input {...p} value={recipients} onChange={(e) => setRecipients(e.target.value)} />}
        </Field>
        <Field label="Subject">
          {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} autoFocus />}
        </Field>
        <Field label="Message">
          {(p) => (
            <Textarea {...p} value={body} onChange={(e) => setBody(e.target.value)} className="min-h-64" />
          )}
        </Field>
      </div>
    </Sheet>
  );
}
