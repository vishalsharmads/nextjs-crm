import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { RelatedType } from '@app/shared';
import { apiGet, apiPost } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { RichTextEditor } from '@/components/editor/rich-text-editor';
import { useSavedReplies } from '@/components/editor/use-templates';
import { Sheet } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { useBoot } from '@/app/session';

/** Write an email to a record's address; it is sent and logged on the record's timeline. */
export function ComposeEmail({
  to,
  related,
  onClose,
  reply,
}: {
  to: string;
  related: { type: RelatedType; uuid: string };
  onClose: () => void;
  /** Answer this email: same conversation, subject prefixed with "Re:". */
  reply?: { activityUuid: string; subject: string };
}) {
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => apiGet<{ data: { uuid: string; email: string }[] }>('/email/accounts').then((r) => r.data),
  });
  const [recipients, setRecipients] = useState(to);
  const [subject, setSubject] = useState(() =>
    reply ? (/^re:/i.test(reply.subject) ? reply.subject : `Re: ${reply.subject}`) : '',
  );
  const [body, setBody] = useState('');
  const [account, setAccount] = useState<string>('');
  const { settings } = useBoot();
  // Offered only where the workspace allows it; the server checks profiles and opt-outs again.
  const canTrack = settings.features.emailTracking && settings.session.profile === 'standard';
  const [track, setTrack] = useState(canTrack);
  // A saved reply fills the subject too, unless one is already written.
  const onRendered = useCallback((r: { subject: string }) => setSubject((s) => s || r.subject), []);
  const replies = useSavedReplies(related, onRendered);
  const send = useMutation({
    mutationFn: () =>
      apiPost('/email/send', {
        to: recipients.split(/[,;\s]+/).filter(Boolean),
        subject,
        body,
        related,
        accountUuid: account || null,
        replyToActivityUuid: reply?.activityUuid ?? null,
        track: canTrack && track,
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
      title={reply ? 'Reply' : 'New email'}
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => send.mutate()}
            loading={send.isPending}
            disabled={!recipients.trim() || !subject.trim() || !body}
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
        <Field label="Message" help="Type / to insert a saved reply.">
          {(p) => (
            <RichTextEditor
              {...p}
              aria-label="Message"
              value={body}
              onChange={setBody}
              replies={replies}
              className="min-h-64"
              onSubmitShortcut={() => {
                if (recipients.trim() && subject.trim() && body) send.mutate();
              }}
            />
          )}
        </Field>
        {canTrack ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={track}
              onCheckedChange={(v) => setTrack(v === true)}
              aria-label="Track opens and clicks"
            />
            Track opens and clicks
          </label>
        ) : null}
      </div>
    </Sheet>
  );
}
