import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, KeyRound, Plus, RefreshCw, Send, Trash2, Webhook } from 'lucide-react';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, EmptyState, Pane, Skeleton } from '@/components/ui/misc';
import { Dialog, DialogContent, Sheet } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/checkbox';
import { Combobox } from '@/components/fields/combobox';
import { SettingsPage } from './layout';

function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast.success('Copied'));
}

/** A secret shown exactly once, with a copy button. */
function OnceSecret({ label, secret, onDone }: { label: string; secret: string; onDone: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onDone()}>
      <DialogContent
        title={label}
        description="Copy it now. For your security it will not be shown again."
        footer={
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        }
      >
        <div className="flex gap-2">
          <Input
            readOnly
            value={secret}
            className="font-mono text-xs"
            onFocus={(e) => e.target.select()}
            aria-label={label}
          />
          <Button onClick={() => copy(secret)} aria-label="Copy">
            <Copy />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------- API keys ----------------

interface ApiKeyRow {
  uuid: string;
  name: string;
  prefix: string;
  role: { key: string; name: string };
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export function ApiKeysPage() {
  const t = useT();
  const qc = useQueryClient();
  const keys = useQuery({
    queryKey: ['api-keys'],
    queryFn: () => apiGet<{ data: ApiKeyRow[] }>('/api-keys').then((r) => r.data),
  });
  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => apiGet<{ data: { key: string; name: string }[] }>('/roles').then((r) => r.data),
  });
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [role, setRole] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => apiPost<ApiKeyRow & { secret: string }>('/api-keys', { name, roleKey: role }),
    onSuccess: (k) => {
      setCreating(false);
      setName('');
      setSecret(k.secret);
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (uuid: string) => apiPost(`/api-keys/${uuid}/revoke`),
    onSuccess: () => {
      toast.success('Key revoked');
      void qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
  });
  return (
    <SettingsPage
      title={t('settings.apiKeys')}
      description="Let other systems use the API. A key acts with one role's permissions; send it as a Bearer token."
      actions={
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus /> New key
        </Button>
      }
    >
      <Pane padded={false}>
        {keys.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : !keys.data?.length ? (
          <EmptyState
            icon={<KeyRound />}
            title="No API keys"
            description="Create one for each integration so you can revoke them separately."
          />
        ) : (
          <ul className="divide-y divide-line">
            {keys.data.map((k) => (
              <li key={k.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{k.name}</p>
                  <p className="text-xs text-muted">
                    <code>{k.prefix}…</code> · {k.role.name} ·{' '}
                    {k.lastUsedAt ? `used ${formatRelative(k.lastUsedAt)}` : 'never used'}
                  </p>
                </div>
                {k.revokedAt ? (
                  <Badge tone="accent">Revoked</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => revoke.mutate(k.uuid)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <Pane title="Using the API">
        <pre className="overflow-x-auto rounded-sm bg-subtle p-3 text-xs">{`curl ${window.location.origin}/api/v1/contacts \\\n  -H "Authorization: Bearer sk_…"`}</pre>
        <p className="mt-2 text-xs text-muted">The full reference is at /api/v1/openapi.json (admins).</p>
      </Pane>
      {creating ? (
        <Dialog open onOpenChange={setCreating}>
          <DialogContent
            title="New API key"
            footer={
              <>
                <Button onClick={() => setCreating(false)}>Cancel</Button>
                <Button
                  variant="primary"
                  onClick={() => create.mutate()}
                  loading={create.isPending}
                  disabled={!name.trim() || !role}
                >
                  Create key
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <Field label="Name" help="What uses this key, e.g. Accounting sync">
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
              </Field>
              <Field label="Acts as role">
                {(p) => (
                  <Combobox
                    {...p}
                    value={role}
                    onChange={(v) => setRole(v as string)}
                    options={(roles.data ?? []).map((r) => ({ value: r.key, label: r.name }))}
                  />
                )}
              </Field>
            </div>
          </DialogContent>
        </Dialog>
      ) : null}
      {secret ? <OnceSecret label="Your new API key" secret={secret} onDone={() => setSecret(null)} /> : null}
    </SettingsPage>
  );
}

// ---------------- Webhooks ----------------

interface WebhookRow {
  uuid: string;
  name: string;
  url: string;
  events: string[];
  active: boolean;
  failureCount: number;
}

export function WebhooksPage() {
  const t = useT();
  const qc = useQueryClient();
  const hooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => apiGet<{ data: WebhookRow[]; events: string[] }>('/webhooks'),
  });
  const [editing, setEditing] = useState<WebhookRow | 'new' | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookRow | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['webhooks'] });
  const toggle = useMutation({
    mutationFn: (w: WebhookRow) => apiPatch(`/webhooks/${w.uuid}`, { active: !w.active }),
    onSuccess: refresh,
  });
  const test = useMutation({
    mutationFn: (w: WebhookRow) =>
      apiPost<{ status: string; responseStatus: number | null; error: string | null }>(
        `/webhooks/${w.uuid}/test`,
      ),
    onSuccess: (r) =>
      r.status === 'succeeded'
        ? toast.success(`Delivered (HTTP ${r.responseStatus})`)
        : toast.error(`Failed: ${r.error}`),
  });
  return (
    <SettingsPage
      title={t('settings.webhooks')}
      description="Send events to other systems as they happen. Each request is signed so the receiver can verify it came from here."
      actions={
        <Button variant="primary" onClick={() => setEditing('new')}>
          <Plus /> New webhook
        </Button>
      }
    >
      <Pane padded={false}>
        {hooks.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : !hooks.data?.data.length ? (
          <EmptyState
            icon={<Webhook />}
            title="No webhooks"
            description="Notify your other tools when records are created, updated or won."
          />
        ) : (
          <ul className="divide-y divide-line">
            {hooks.data.data.map((w) => (
              <li key={w.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 font-medium">
                    {w.name} {w.failureCount ? <Badge tone="accent">{w.failureCount} failures</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-muted">{w.url}</p>
                  <p className="truncate text-xs text-faint">{w.events.join(', ')}</p>
                </div>
                <Switch
                  checked={w.active}
                  onCheckedChange={() => toggle.mutate(w)}
                  aria-label={`${w.name} active`}
                />
                <Button size="sm" variant="ghost" onClick={() => test.mutate(w)}>
                  <Send /> Test
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setDeliveries(w)}>
                  Deliveries
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditing(w)}>
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <Pane title="Verifying requests">
        <p className="text-sm text-muted">
          Compute HMAC-SHA256 of <code>{'{X-Webhook-Timestamp}.{raw body}'}</code> with your signing secret
          and compare it with <code>X-Webhook-Signature</code> (prefixed <code>sha256=</code>). Reject
          timestamps older than five minutes.
        </p>
      </Pane>
      {editing ? (
        <WebhookEditor
          hook={editing === 'new' ? null : editing}
          events={hooks.data?.events ?? []}
          onClose={() => setEditing(null)}
          onSaved={(s) => (refresh(), s && setSecret(s))}
        />
      ) : null}
      {deliveries ? <DeliveriesSheet hook={deliveries} onClose={() => setDeliveries(null)} /> : null}
      {secret ? <OnceSecret label="Signing secret" secret={secret} onDone={() => setSecret(null)} /> : null}
    </SettingsPage>
  );
}

function WebhookEditor({
  hook,
  events,
  onClose,
  onSaved,
}: {
  hook: WebhookRow | null;
  events: string[];
  onClose: () => void;
  onSaved: (secret?: string) => void;
}) {
  const [name, setName] = useState(hook?.name ?? '');
  const [url, setUrl] = useState(hook?.url ?? 'https://');
  const [selected, setSelected] = useState<string[]>(hook?.events ?? []);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      hook
        ? apiPatch<WebhookRow>(`/webhooks/${hook.uuid}`, { name, url, events: selected })
        : apiPost<WebhookRow & { secret: string }>('/webhooks', { name, url, events: selected }),
    onSuccess: (r) => {
      onSaved((r as { secret?: string }).secret);
      onClose();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? (err.fieldErrors().url ?? err.message) : 'Could not save'),
  });
  const remove = useMutation({
    mutationFn: () => apiDelete(`/webhooks/${hook!.uuid}`),
    onSuccess: () => (onSaved(), onClose()),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title={hook ? 'Edit webhook' : 'New webhook'}
        footer={
          <>
            {hook ? (
              <Button variant="ghost" className="me-auto text-accent" onClick={() => remove.mutate()}>
                <Trash2 /> Delete
              </Button>
            ) : null}
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!name.trim() || !selected.length}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="Name">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Field
            label="URL"
            error={error ?? undefined}
            help="Must be reachable from the internet over https."
          >
            {(p) => <Input {...p} type="url" value={url} onChange={(e) => setUrl(e.target.value)} />}
          </Field>
          <Field label="Events">
            {(p) => (
              <Combobox
                {...p}
                multiple
                value={selected}
                onChange={(v) => setSelected(v as string[])}
                options={[
                  { value: '*', label: 'All events' },
                  ...events.map((e) => ({ value: e, label: e })),
                ]}
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeliveriesSheet({ hook, onClose }: { hook: WebhookRow; onClose: () => void }) {
  const q = useQuery({
    queryKey: ['webhooks', hook.uuid, 'deliveries'],
    queryFn: () =>
      apiGet<{
        data: {
          uuid: string;
          event: string;
          status: string;
          attempts: number;
          responseStatus: number | null;
          error: string | null;
          createdAt: string;
        }[];
      }>(`/webhooks/${hook.uuid}/deliveries`).then((r) => r.data),
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Deliveries · ${hook.name}`}
      headerActions={
        <Button size="icon-sm" variant="ghost" aria-label="Refresh" onClick={() => q.refetch()}>
          <RefreshCw />
        </Button>
      }
    >
      {q.isPending ? (
        <Skeleton className="m-5 h-32" />
      ) : !q.data?.length ? (
        <EmptyState title="No deliveries yet" />
      ) : (
        <ul className="divide-y divide-line">
          {q.data.map((d) => (
            <li key={d.uuid} className="flex items-center gap-3 px-5 py-2.5 text-sm">
              <Badge
                tone={d.status === 'succeeded' ? 'primary' : d.status === 'failed' ? 'accent' : 'outline'}
              >
                {d.status}
              </Badge>
              <span className="min-w-0 flex-1 truncate">{d.event}</span>
              <span className="text-xs text-muted">
                {d.responseStatus ? `HTTP ${d.responseStatus}` : (d.error ?? '')}
              </span>
              <span className="text-xs text-faint">{formatDateTime(d.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}

// ---------------- Templates ----------------

interface TemplateRow {
  uuid: string | null;
  key: string;
  channel: string;
  locale: string;
  name: string;
  subject: string;
  body: string;
  builtIn: boolean;
}

export function TemplatesPage() {
  const t = useT();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['templates'],
    queryFn: () => apiGet<{ data: TemplateRow[] }>('/templates').then((r) => r.data),
  });
  const [editing, setEditing] = useState<TemplateRow | null>(null);
  return (
    <SettingsPage
      title={t('settings.templates')}
      description="The wording of emails people receive. Variables like {{branding.appName}} and {{labels.contact.singular}} are filled in when sent."
    >
      <Pane padded={false}>
        {list.isPending ? (
          <Skeleton className="m-4 h-24" />
        ) : (
          <ul className="divide-y divide-line">
            {list.data?.map((tpl) => (
              <li key={`${tpl.key}:${tpl.channel}:${tpl.locale}`}>
                <button
                  type="button"
                  onClick={() => setEditing(tpl)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-start text-sm hover:bg-hover"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{tpl.name}</p>
                    <p className="truncate text-xs text-muted">{tpl.subject}</p>
                  </div>
                  <Badge tone="outline">{tpl.channel}</Badge>
                  {tpl.builtIn ? <Badge>Default</Badge> : <Badge tone="primary">Customized</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {editing ? (
        <TemplateEditor
          template={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void qc.invalidateQueries({ queryKey: ['templates'] })}
        />
      ) : null}
    </SettingsPage>
  );
}

function TemplateEditor({
  template,
  onClose,
  onSaved,
}: {
  template: TemplateRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ subject: string; html: string } | null>(null);
  useEffect(() => {
    const id = setTimeout(() => {
      apiPost<{ subject: string; html: string }>('/templates/preview', { subject, body })
        .then((p) => (setPreview(p), setError(null)))
        .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Preview failed'));
    }, 400);
    return () => clearTimeout(id);
  }, [subject, body]);
  const save = useMutation({
    mutationFn: () =>
      template.uuid
        ? apiPatch(`/templates/${template.uuid}`, { subject, body })
        : apiPost('/templates', {
            key: template.key,
            channel: template.channel,
            locale: template.locale,
            name: template.name,
            subject,
            body,
          }),
    onSuccess: () => {
      toast.success('Template saved');
      onSaved();
      onClose();
    },
  });
  const reset = useMutation({
    mutationFn: () => apiDelete(`/templates/${template.uuid}`),
    onSuccess: () => {
      toast.success('Back to the default wording');
      onSaved();
      onClose();
    },
  });
  return (
    <Sheet
      open
      onOpenChange={(o) => !o && onClose()}
      title={template.name}
      description={template.key}
      width="max-w-5xl"
      footer={
        <>
          {template.uuid ? (
            <Button variant="ghost" className="me-auto" onClick={() => reset.mutate()}>
              Reset to default
            </Button>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending} disabled={!!error}>
            Save template
          </Button>
        </>
      }
    >
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <Field label="Subject">
            {(p) => <Input {...p} value={subject} onChange={(e) => setSubject(e.target.value)} />}
          </Field>
          <Field label="Body (HTML)" error={error ?? undefined}>
            {(p) => (
              <Textarea
                {...p}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="min-h-96 font-mono text-xs"
              />
            )}
          </Field>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted">Preview</p>
          <p className="text-sm font-medium">{preview?.subject}</p>
          {/* Sandboxed: template HTML can never run script in the app's origin. */}
          <iframe
            title="Template preview"
            sandbox=""
            srcDoc={preview?.html ?? ''}
            className="min-h-96 w-full flex-1 rounded-md border border-line bg-surface"
          />
        </div>
      </div>
    </Sheet>
  );
}

// ---------------- Email ----------------

interface MailAccount {
  uuid: string;
  email: string;
  displayName: string;
  smtp: { host: string; port: number; secure: boolean };
  imap: { host: string; port: number; secure: boolean } | null;
  lastSyncAt: string | null;
  lastError: string | null;
}

export function EmailSettingsPage() {
  const t = useT();
  const qc = useQueryClient();
  const accounts = useQuery({
    queryKey: ['mail-accounts'],
    queryFn: () => apiGet<{ data: MailAccount[] }>('/email/accounts').then((r) => r.data),
  });
  const [connecting, setConnecting] = useState(false);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['mail-accounts'] });
  const sync = useMutation({
    mutationFn: (uuid: string) => apiPost<{ logged: number }>(`/email/accounts/${uuid}/sync`),
    onSuccess: (r) => (toast.success(`${r.logged} new emails logged`), refresh()),
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/email/accounts/${uuid}`),
    onSuccess: refresh,
  });
  return (
    <SettingsPage
      title={t('settings.email')}
      description="Connect your mailbox to send from your own address and log replies from known people automatically."
      actions={
        <Button variant="primary" onClick={() => setConnecting(true)}>
          <Plus /> Connect mailbox
        </Button>
      }
    >
      <Pane padded={false}>
        {accounts.isPending ? (
          <Skeleton className="m-4 h-16" />
        ) : !accounts.data?.length ? (
          <EmptyState
            title="No mailbox connected"
            description="Without one, emails are sent from the workspace address with replies going to you."
          />
        ) : (
          <ul className="divide-y divide-line">
            {accounts.data.map((a) => (
              <li key={a.uuid} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{a.email}</p>
                  <p className="text-xs text-muted">
                    Sending via {a.smtp.host}
                    {a.imap
                      ? ` · syncing ${a.imap.host}${a.lastSyncAt ? `, last ${formatRelative(a.lastSyncAt)}` : ''}`
                      : ' · not syncing'}
                  </p>
                  {a.lastError ? <p className="text-xs text-accent">{a.lastError}</p> : null}
                </div>
                {a.imap ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => sync.mutate(a.uuid)}
                    loading={sync.isPending}
                  >
                    <RefreshCw /> Sync now
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={() => remove.mutate(a.uuid)}>
                  Disconnect
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      {connecting ? <ConnectMailbox onClose={() => setConnecting(false)} onSaved={refresh} /> : null}
    </SettingsPage>
  );
}

function ConnectMailbox({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({
    email: '',
    displayName: '',
    password: '',
    smtpHost: '',
    smtpPort: '465',
    smtpSecure: true,
    imapHost: '',
    imapPort: '993',
    sync: true,
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof v, val: string | boolean) => setV((x) => ({ ...x, [k]: val }));
  const save = useMutation({
    mutationFn: () =>
      apiPost('/email/accounts', {
        email: v.email,
        displayName: v.displayName,
        password: v.password,
        smtp: { host: v.smtpHost, port: Number(v.smtpPort), secure: v.smtpSecure },
        imap: v.sync && v.imapHost ? { host: v.imapHost, port: Number(v.imapPort), secure: true } : null,
      }),
    onSuccess: () => {
      toast.success('Mailbox connected');
      onSaved();
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'Could not connect'),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="Connect mailbox"
        description="Use an app password if your provider requires one. It is stored encrypted."
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!v.email || !v.password || !v.smtpHost}
            >
              Connect
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          {error ? <p className="text-sm text-accent sm:col-span-2">{error}</p> : null}
          <Field label="Email">
            {(p) => (
              <Input {...p} type="email" value={v.email} onChange={(e) => set('email', e.target.value)} />
            )}
          </Field>
          <Field label="Display name">
            {(p) => (
              <Input {...p} value={v.displayName} onChange={(e) => set('displayName', e.target.value)} />
            )}
          </Field>
          <Field label="Password" className="sm:col-span-2">
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={v.password}
                onChange={(e) => set('password', e.target.value)}
              />
            )}
          </Field>
          <Field label="Outgoing server (SMTP)">
            {(p) => (
              <Input
                {...p}
                value={v.smtpHost}
                onChange={(e) => set('smtpHost', e.target.value)}
                placeholder="smtp.example.com"
              />
            )}
          </Field>
          <Field label="Port">
            {(p) => (
              <NativeSelect
                {...p}
                value={v.smtpPort}
                onChange={(e) => (
                  set('smtpPort', e.target.value),
                  set('smtpSecure', e.target.value === '465')
                )}
              >
                <option value="465">465 (SSL)</option>
                <option value="587">587 (STARTTLS)</option>
              </NativeSelect>
            )}
          </Field>
          <label className="flex items-center justify-between gap-3 text-sm sm:col-span-2">
            Log incoming email from known people{' '}
            <Switch checked={v.sync} onCheckedChange={(x) => set('sync', x)} />
          </label>
          {v.sync ? (
            <>
              <Field label="Incoming server (IMAP)">
                {(p) => (
                  <Input
                    {...p}
                    value={v.imapHost}
                    onChange={(e) => set('imapHost', e.target.value)}
                    placeholder="imap.example.com"
                  />
                )}
              </Field>
              <Field label="Port">
                {(p) => <Input {...p} value={v.imapPort} onChange={(e) => set('imapPort', e.target.value)} />}
              </Field>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
