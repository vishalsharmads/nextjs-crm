import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, MessageSquarePlus, Send, Trash2, X } from 'lucide-react';
import type { WebModule } from '@app/module-sdk';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Badge,
  EmptyState,
  ErrorState,
  PageHeader,
  Pane,
  Skeleton,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/misc';

interface Proposal {
  id: string;
  name: string;
  title: string;
  input: Record<string, unknown>;
}
interface Conversation {
  uuid: string;
  title: string;
  messages: { role: 'user' | 'assistant'; text?: string; tools?: string[] }[];
  proposals: Proposal[];
}
interface Config {
  name: string;
  provider: 'messages' | 'chat_completions' | null;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  headerNames: string[];
  monthlyTokenCap: number;
  userDailyTokenCap: number;
  retentionDays: number;
  excludedEntities: string[];
  hipaaAcknowledged: boolean;
  complianceProfile?: string;
}

const key = ['m', 'assistant'] as const;
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';

function AssistantPage() {
  const can = useCan();
  const status = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => apiGet<{ name: string; ready: boolean }>('/m/assistant/status'),
  });
  const admin = can('assistant.settings.manage');
  const name = status.data?.name ?? 'Assistant';
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={name} />
      {admin ? (
        <Tabs defaultValue="chat">
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="mt-4">
            <Chat ready={!!status.data?.ready} loading={status.isPending} admin />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsPanel />
          </TabsContent>
        </Tabs>
      ) : (
        <Chat ready={!!status.data?.ready} loading={status.isPending} admin={false} />
      )}
    </div>
  );
}

function Chat({ ready, loading, admin }: { ready: boolean; loading: boolean; admin: boolean }) {
  const qc = useQueryClient();
  const { labels } = useBoot();
  const [params] = useSearchParams();
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState('');
  const list = useQuery({
    queryKey: [...key, 'conversations'],
    queryFn: () =>
      apiGet<{ data: { uuid: string; title: string; updatedAt: string }[] }>(
        '/m/assistant/conversations',
      ).then((r) => r.data),
    enabled: ready,
  });
  const conv = useQuery({
    queryKey: [...key, 'conversation', active],
    queryFn: () => apiGet<Conversation>(`/m/assistant/conversations/${active}`),
    enabled: !!active,
  });
  // `?about=contact:<uuid>` from a record page: the assistant knows what the person is looking at.
  const about = params.get('about');
  const context =
    about && /^[a-z_]+:[0-9a-f-]{36}$/.test(about)
      ? { entity: about.split(':')[0]!, uuid: about.split(':')[1]! }
      : undefined;
  const done = (c: Conversation) => {
    qc.setQueryData([...key, 'conversation', c.uuid], c);
    setActive(c.uuid);
    void qc.invalidateQueries({ queryKey: [...key, 'conversations'] });
  };
  const send = useMutation({
    mutationFn: (message: string) =>
      active
        ? apiPost<Conversation>(`/m/assistant/conversations/${active}/messages`, { text: message, context })
        : apiPost<Conversation>('/m/assistant/conversations', { text: message, context }),
    onSuccess: (c) => {
      setText('');
      done(c);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const decide = useMutation({
    mutationFn: (decisions: Record<string, boolean>) =>
      apiPost<Conversation>(`/m/assistant/conversations/${active}/decisions`, { decisions }),
    onSuccess: (c) => {
      done(c);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'm' });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/m/assistant/conversations/${uuid}`),
    onSuccess: (_r, uuid) => {
      toast.success('Deleted');
      if (uuid === active) setActive(null);
      void qc.invalidateQueries({ queryKey: [...key, 'conversations'] });
    },
  });
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(
    () => bottom.current?.scrollIntoView({ block: 'end' }),
    [conv.data?.messages.length, send.isPending],
  );

  if (loading) return <Skeleton className="h-64" />;
  if (!ready)
    return (
      <Pane>
        <EmptyState
          title="The assistant is not set up yet"
          description={
            admin
              ? 'Choose a provider, model and API key in Settings to turn it on.'
              : 'Ask an admin to set it up.'
          }
        />
      </Pane>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !send.isPending) send.mutate(text.trim());
  };
  const proposals = conv.data?.proposals ?? [];
  return (
    <div className="grid gap-4 md:grid-cols-[240px_1fr]">
      <Pane padded={false} className="h-fit">
        <div className="border-b border-line p-2">
          <Button size="sm" className="w-full" onClick={() => setActive(null)}>
            <MessageSquarePlus /> New conversation
          </Button>
        </div>
        {list.isPending ? (
          <Skeleton className="m-3 h-16" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : !list.data.length ? (
          <p className="p-3 text-sm text-muted">No conversations yet.</p>
        ) : (
          <ul className="max-h-[60vh] overflow-y-auto">
            {list.data.map((c) => (
              <li key={c.uuid} className="group flex items-center">
                <button
                  type="button"
                  onClick={() => setActive(c.uuid)}
                  className={cn(
                    'min-w-0 flex-1 px-3 py-2 text-start text-sm hover:bg-subtle',
                    c.uuid === active && 'bg-subtle font-medium',
                  )}
                >
                  <span className="block truncate">{c.title}</span>
                  <span className="text-xs text-faint">{formatRelative(c.updatedAt)}</span>
                </button>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Delete ${c.title}`}
                  onClick={() => remove.mutate(c.uuid)}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Pane>
      <Pane padded={false}>
        <div className="flex min-h-[50vh] flex-col">
          <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
            {!active && !send.isPending ? (
              <EmptyState
                title="Ask about your records"
                description={`For example: which ${(labels.deal?.plural ?? '').toLowerCase()} close this month, summarise the history of this ${(labels.contact?.singular ?? '').toLowerCase()}, or draft a follow-up note.`}
              />
            ) : conv.isError ? (
              <ErrorState error={conv.error} onRetry={() => void conv.refetch()} />
            ) : (
              conv.data?.messages.map((m, i) => (
                <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                  <div
                    className={cn(
                      'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                      m.role === 'user' ? 'bg-primary text-primary-fg' : 'bg-subtle text-ink',
                    )}
                  >
                    {m.text}
                    {m.tools?.length ? (
                      <p className={cn('text-xs', m.role === 'user' ? '' : 'text-faint', m.text && 'mt-1')}>
                        {m.tools.join(' · ')}
                      </p>
                    ) : null}
                  </div>
                </div>
              ))
            )}
            {send.isPending || decide.isPending ? <p className="text-sm text-muted">Working…</p> : null}
            {proposals.length ? (
              <Proposals proposals={proposals} onDecide={(d) => decide.mutate(d)} busy={decide.isPending} />
            ) : null}
            <div ref={bottom} />
          </div>
          <form onSubmit={submit} className="flex gap-2 border-t border-line p-3">
            {context ? <Badge tone="outline">About this record</Badge> : null}
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ask anything about your records"
              aria-label="Message"
              disabled={proposals.length > 0}
              maxLength={4000}
            />
            <Button
              type="submit"
              variant="primary"
              loading={send.isPending}
              disabled={!text.trim() || proposals.length > 0}
            >
              <Send /> Send
            </Button>
          </form>
        </div>
      </Pane>
    </div>
  );
}

/** Each change the assistant wants to make, shown in full; nothing runs until the person confirms. */
function Proposals({
  proposals,
  onDecide,
  busy,
}: {
  proposals: Proposal[];
  onDecide: (d: Record<string, boolean>) => void;
  busy: boolean;
}) {
  const all = (v: boolean) => Object.fromEntries(proposals.map((p) => [p.id, v]));
  return (
    <div
      className="rounded-md border border-line-strong bg-surface p-3"
      role="group"
      aria-label="Proposed changes"
    >
      <p className="mb-2 text-sm font-medium">
        Confirm {proposals.length === 1 ? 'this change' : 'these changes'}
      </p>
      <ul className="space-y-2">
        {proposals.map((p) => (
          <li key={p.id} className="text-sm">
            <p className="font-medium">{p.title}</p>
            <pre className="mt-1 overflow-x-auto rounded bg-subtle p-2 text-xs">
              {JSON.stringify(p.input, null, 2)}
            </pre>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex gap-2">
        <Button variant="primary" size="sm" onClick={() => onDecide(all(true))} loading={busy}>
          <Check /> Confirm
        </Button>
        <Button size="sm" onClick={() => onDecide(all(false))} disabled={busy}>
          <X /> Decline
        </Button>
      </div>
    </div>
  );
}

function SettingsPanel() {
  const qc = useQueryClient();
  const { labels } = useBoot();
  const config = useQuery({
    queryKey: [...key, 'config'],
    queryFn: () => apiGet<Config>('/m/assistant/config'),
  });
  const usage = useQuery({
    queryKey: [...key, 'usage'],
    queryFn: () =>
      apiGet<{
        month: string;
        data: { name: string; requests: number; inputTokens: number; outputTokens: number }[];
      }>('/m/assistant/usage'),
  });
  const [draft, setDraft] = useState<Config | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState('');
  useEffect(() => {
    if (config.data) setDraft(config.data);
  }, [config.data]);
  const save = useMutation({
    mutationFn: () => {
      const d = draft!;
      const extra = headers.trim()
        ? Object.fromEntries(
            headers
              .split('\n')
              .map((l) => l.split(':'))
              .filter((p) => p.length >= 2)
              .map(([k, ...v]) => [k!.trim(), v.join(':').trim()]),
          )
        : undefined;
      return apiPatch<Config>('/m/assistant/config', {
        name: d.name,
        provider: d.provider,
        baseUrl: d.baseUrl || null,
        model: d.model || null,
        monthlyTokenCap: d.monthlyTokenCap,
        userDailyTokenCap: d.userDailyTokenCap,
        retentionDays: d.retentionDays,
        excludedEntities: d.excludedEntities,
        hipaaAcknowledged: d.hipaaAcknowledged,
        ...(apiKey ? { apiKey } : {}),
        ...(extra ? { headers: extra } : {}),
      });
    },
    onSuccess: () => {
      toast.success('Saved');
      setApiKey('');
      setHeaders('');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorText(err)),
  });
  if (config.isPending || !draft) return <Skeleton className="h-64" />;
  if (config.isError) return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  const set = (patch: Partial<Config>) => setDraft({ ...draft, ...patch });
  const entities = ['contact', 'organization', 'lead', 'deal', 'activity'];
  return (
    <div className="flex flex-col gap-4">
      <Pane title="Provider">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Assistant name" help="Shown to everyone instead of the provider's name.">
            {(p) => <Input {...p} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}
          </Field>
          <Field label="API format">
            {(p) => (
              <NativeSelect
                {...p}
                value={draft.provider ?? ''}
                onChange={(e) => set({ provider: (e.target.value || null) as Config['provider'] })}
              >
                <option value="">Not set</option>
                <option value="messages">Messages API</option>
                <option value="chat_completions">Chat completions API</option>
              </NativeSelect>
            )}
          </Field>
          <Field
            label="Base URL"
            help="The provider's API address. Messages API: the host (…/v1/messages is added). Chat completions: up to and including /v1."
          >
            {(p) => (
              <Input {...p} value={draft.baseUrl ?? ''} onChange={(e) => set({ baseUrl: e.target.value })} />
            )}
          </Field>
          <Field label="Model">
            {(p) => (
              <Input {...p} value={draft.model ?? ''} onChange={(e) => set({ model: e.target.value })} />
            )}
          </Field>
          <Field
            label="API key"
            help={draft.hasApiKey ? 'A key is saved. Enter a new one to replace it.' : 'Stored encrypted.'}
          >
            {(p) => (
              <Input
                {...p}
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Extra request headers"
            help={
              draft.headerNames.length
                ? `Saved: ${draft.headerNames.join(', ')}. One "Name: value" per line replaces them.`
                : 'One "Name: value" per line, if your provider needs any (for example an API version).'
            }
          >
            {(p) => <Textarea {...p} rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} />}
          </Field>
        </div>
      </Pane>
      <Pane title="Limits and data">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Tokens per month (0 = no limit)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                value={draft.monthlyTokenCap}
                onChange={(e) => set({ monthlyTokenCap: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Tokens per person per day (0 = no limit)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={0}
                value={draft.userDailyTokenCap}
                onChange={(e) => set({ userDailyTokenCap: Number(e.target.value) })}
              />
            )}
          </Field>
          <Field label="Keep conversations (days)">
            {(p) => (
              <Input
                {...p}
                type="number"
                min={1}
                max={365}
                value={draft.retentionDays}
                onChange={(e) => set({ retentionDays: Number(e.target.value) })}
              />
            )}
          </Field>
        </div>
        <fieldset className="mt-4 flex flex-wrap gap-4">
          <legend className="mb-2 text-xs font-medium text-muted">Never send these to the provider</legend>
          {entities.map((e) => (
            <label key={e} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.excludedEntities.includes(e)}
                onCheckedChange={(on) =>
                  set({
                    excludedEntities: on
                      ? [...draft.excludedEntities, e]
                      : draft.excludedEntities.filter((x) => x !== e),
                  })
                }
              />
              {labels[e]?.plural ?? e}
            </label>
          ))}
        </fieldset>
        <p className="mt-3 text-xs text-muted">
          Only fields each person can see are sent, and sensitive values stay masked. Changes the assistant
          proposes run only after the person confirms them, and are recorded in the audit log.
        </p>
        {config.data.complianceProfile === 'hipaa' ? (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <Checkbox
              checked={draft.hipaaAcknowledged}
              onCheckedChange={(v) => set({ hipaaAcknowledged: v })}
              className="mt-0.5"
            />
            I confirm we have an agreement with this provider that covers health information. The assistant
            stays off until this is confirmed.
          </label>
        ) : null}
        <div className="mt-4">
          <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </Pane>
      <Pane title={`Usage this month${usage.data ? ` (${usage.data.month})` : ''}`} padded={false}>
        {usage.isPending ? (
          <Skeleton className="m-4 h-10" />
        ) : !usage.data?.data.length ? (
          <p className="p-4 text-sm text-muted">No usage yet this month.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="px-4 py-2 text-start font-medium">Person</th>
                <th className="px-4 py-2 text-end font-medium">Requests</th>
                <th className="px-4 py-2 text-end font-medium">Tokens in</th>
                <th className="px-4 py-2 text-end font-medium">Tokens out</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {usage.data.data.map((u) => (
                <tr key={u.name}>
                  <td className="px-4 py-2">{u.name}</td>
                  <td className="tabular px-4 py-2 text-end">{u.requests}</td>
                  <td className="tabular px-4 py-2 text-end">{u.inputTokens.toLocaleString()}</td>
                  <td className="tabular px-4 py-2 text-end">{u.outputTokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Pane>
    </div>
  );
}

const assistantModule: WebModule = { key: 'assistant', routes: [{ path: '', element: <AssistantPage /> }] };
export default assistantModule;
