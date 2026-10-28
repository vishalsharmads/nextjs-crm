import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { KeyRound, Plus } from 'lucide-react';
import type { McpSettings, PersonalTokenDto, ToolInfo } from '@app/shared';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import { useT } from '@/app/session';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect } from '@/components/ui/input';
import { Badge, EmptyState, ErrorState, Pane, Skeleton } from '@/components/ui/misc';
import { Checkbox, Switch } from '@/components/ui/checkbox';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { OnceSecret } from './integration-pages';
import { SettingsPage } from './layout';

const tokensKey = ['me', 'tokens'] as const;

/** The MCP endpoint is served by the API, at the site root next to the app. */
const mcpUrl = () => new URL('/api/v1/mcp', window.location.href).href;

/** Profile → Access tokens: personal tokens for AI clients, acting as the signed-in person. */
export function AccessTokens() {
  const qc = useQueryClient();
  const tokens = useQuery({
    queryKey: tokensKey,
    queryFn: () => apiGet<{ data: PersonalTokenDto[] }>('/me/tokens').then((r) => r.data),
  });
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const revoke = useMutation({
    mutationFn: (uuid: string) => apiPost(`/me/tokens/${uuid}/revoke`),
    onSuccess: () => {
      toast.success('Revoked');
      void qc.invalidateQueries({ queryKey: tokensKey });
    },
  });
  const active = tokens.data?.filter((t) => !t.revokedAt && new Date(t.expiresAt) > new Date()) ?? [];
  return (
    <Pane
      title="Access tokens"
      padded={false}
      actions={
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus /> New token
        </Button>
      }
    >
      <p className="border-b border-line px-4 py-3 text-sm text-muted">
        Connect an AI client over MCP at <code className="text-ink">{mcpUrl()}</code>. A token acts as you,
        with your permissions. An admin must turn on AI clients first.
      </p>
      {tokens.isPending ? (
        <Skeleton className="m-4 h-10" />
      ) : tokens.isError ? (
        <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />
      ) : !active.length ? (
        <EmptyState
          icon={<KeyRound />}
          title="No tokens"
          description="Create a token to let an AI client read or update your records."
          action={<Button onClick={() => setCreating(true)}>Create a token</Button>}
        />
      ) : (
        <ul className="divide-y divide-line">
          {active.map((t) => (
            <li key={t.uuid} className="flex items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                  {t.name}
                  <Badge tone="outline">{t.access === 'read' ? 'Read only' : 'Read and write'}</Badge>
                </p>
                <p className="text-xs text-muted">
                  <span className="font-mono">{t.prefix}…</span> · expires {formatDateTime(t.expiresAt)} ·{' '}
                  {t.lastUsedAt ? `last used ${formatRelative(t.lastUsedAt)}` : 'never used'}
                </p>
              </div>
              <Button size="sm" variant="ghost" onClick={() => revoke.mutate(t.uuid)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <TokenDialog
          onClose={() => setCreating(false)}
          onCreated={(s) => {
            setCreating(false);
            setSecret(s);
          }}
        />
      ) : null}
      {secret ? (
        <OnceSecret label="Your new access token" secret={secret} onDone={() => setSecret(null)} />
      ) : null}
    </Pane>
  );
}

function TokenDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (secret: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [access, setAccess] = useState<'read' | 'full'>('read');
  const [days, setDays] = useState(90);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useMutation({
    mutationFn: () =>
      apiPost<PersonalTokenDto & { secret: string }>('/me/tokens', { name, access, expiresInDays: days }),
    onSuccess: (t) => {
      void qc.invalidateQueries({ queryKey: tokensKey });
      onCreated(t.secret);
    },
    onError: (err) => {
      const fields = err instanceof ApiError ? err.fieldErrors() : {};
      if (Object.keys(fields).length) setErrors(fields);
      else toast.error(err instanceof ApiError ? err.message : 'Could not create the token');
    },
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        title="New access token"
        footer={
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => create.mutate()}
              loading={create.isPending}
              disabled={!name.trim()}
            >
              Create
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name" required error={errors.name} help="For example the client it is for.">
            {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
          </Field>
          <Field label="Access">
            {(p) => (
              <NativeSelect
                {...p}
                value={access}
                onChange={(e) => setAccess(e.target.value as 'read' | 'full')}
              >
                <option value="read">Read only</option>
                <option value="full">Read and write</option>
              </NativeSelect>
            )}
          </Field>
          <Field label="Expires after (days)" error={errors.expiresInDays}>
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={365}
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              />
            )}
          </Field>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → AI clients: turn MCP on, choose the tools clients may call, and set the rate limit. */
export function AiClientsPage() {
  const t = useT();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ['settings', 'mcp'],
    queryFn: () => apiGet<{ mcp: McpSettings }>('/settings').then((r) => r.mcp),
  });
  const tools = useQuery({
    queryKey: ['tools'],
    queryFn: () => apiGet<{ data: ToolInfo[] }>('/tools').then((r) => r.data),
  });
  const [draft, setDraft] = useState<McpSettings | null>(null);
  useEffect(() => {
    if (settings.data) setDraft(settings.data);
  }, [settings.data]);
  const save = useMutation({
    mutationFn: (next: McpSettings) => apiPatch('/settings/mcp', next),
    onSuccess: () => {
      toast.success('Saved');
      void qc.invalidateQueries({ queryKey: ['settings'] });
    },
    onError: (err) => toast.error(err instanceof ApiError ? err.message : 'Could not save'),
  });
  const allowed = (name: string) => !draft?.tools.length || draft.tools.includes(name);
  const toggleTool = (name: string, on: boolean) => {
    if (!draft || !tools.data) return;
    const current = draft.tools.length ? draft.tools : tools.data.map((x) => x.name);
    const next = on ? [...current, name] : current.filter((n) => n !== name);
    setDraft({ ...draft, tools: next.length === tools.data.length ? [] : next });
  };
  return (
    <SettingsPage
      title={t('settings.aiClients')}
      description="Let AI assistants that support MCP work with this workspace. Each person connects with their own access token, and every call runs with that person's permissions and is recorded in the audit log."
      actions={
        <Button
          variant="primary"
          onClick={() => draft && save.mutate(draft)}
          loading={save.isPending}
          disabled={!draft}
        >
          Save
        </Button>
      }
    >
      {settings.isPending || tools.isPending || !draft ? (
        <Skeleton className="h-40" />
      ) : settings.isError || tools.isError ? (
        <ErrorState error={settings.error ?? tools.error} onRetry={() => void settings.refetch()} />
      ) : (
        <>
          <Pane>
            <div className="flex flex-col gap-4">
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>
                  <span className="font-medium">Allow AI clients</span>
                  <span className="block text-muted">Endpoint: {mcpUrl()}</span>
                </span>
                <Switch
                  checked={draft.enabled}
                  onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
                  aria-label="Allow AI clients"
                />
              </label>
              <Field label="Calls per token per minute" className="max-w-48">
                {(p) => (
                  <Input
                    {...p}
                    type="number"
                    min={1}
                    max={1000}
                    value={draft.rateLimitPerMinute}
                    onChange={(e) => setDraft({ ...draft, rateLimitPerMinute: Number(e.target.value) })}
                  />
                )}
              </Field>
            </div>
          </Pane>
          <Pane title="Tools" padded={false}>
            <ul className="divide-y divide-line">
              {tools.data.map((tool) => (
                <li key={tool.name} className="flex items-start gap-3 px-4 py-3">
                  <Checkbox
                    checked={allowed(tool.name)}
                    onCheckedChange={(on) => toggleTool(tool.name, on)}
                    aria-label={tool.title}
                    className="mt-0.5"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {tool.title}
                      {tool.write ? <Badge>Changes data</Badge> : null}
                    </p>
                    <p className="text-xs text-muted">{tool.description}</p>
                  </div>
                </li>
              ))}
            </ul>
          </Pane>
        </>
      )}
    </SettingsPage>
  );
}
