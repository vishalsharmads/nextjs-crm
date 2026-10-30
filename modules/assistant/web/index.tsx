import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, MessageSquarePlus, Send, Sparkles, Trash2, X } from 'lucide-react';
import type { WebModule } from '@app/module-sdk';
import { SettingsPanel } from './settings';
import { ApiError, apiDelete, apiGet, apiStream } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Badge,
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

const key = ['m', 'assistant'] as const;
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';

function AssistantPage() {
  const can = useCan();
  const status = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => apiGet<{ name: string; ready: boolean; setup: boolean }>('/m/assistant/status'),
  });
  const admin = can('assistant.settings.manage');
  const [tab, setTab] = useState('chat');
  const name = status.data?.name ?? 'Assistant';
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={name} />
      {admin ? (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
          <TabsContent value="chat" className="mt-4">
            <Chat
              ready={!!status.data?.ready}
              loading={status.isPending}
              setup={!!status.data?.setup}
              admin
              onSetUp={() => setTab('settings')}
            />
          </TabsContent>
          <TabsContent value="settings" className="mt-4">
            <SettingsPanel />
          </TabsContent>
        </Tabs>
      ) : (
        <Chat
          ready={!!status.data?.ready}
          loading={status.isPending}
          setup={!!status.data?.setup}
          admin={false}
        />
      )}
    </div>
  );
}

function Chat({
  ready,
  loading,
  admin,
  compact = false,
  record,
  setup = false,
  onSetUp,
}: {
  ready: boolean;
  loading: boolean;
  admin: boolean;
  /** The side panel: no conversation list, the latest conversation only. */
  compact?: boolean;
  /** The record on screen, when opened from a record page. */
  record?: { entity: string; uuid: string };
  /** This person can ask the assistant to set up the workspace. */
  setup?: boolean;
  /** Open the assistant settings (admins, when it is not set up). */
  onSetUp?: () => void;
}) {
  const qc = useQueryClient();
  const { labels } = useBoot();
  const [params] = useSearchParams();
  // What the assistant is saying right now, and the steps it is taking, while a reply streams in.
  const [live, setLive] = useState<{ text: string; steps: string[] } | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [text, setText] = useState(() => params.get('ask')?.slice(0, 4000) ?? '');
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
  const context = record?.uuid
    ? record
    : about && /^[a-z_]+:[0-9a-f-]{36}$/.test(about)
      ? { entity: about.split(':')[0]!, uuid: about.split(':')[1]! }
      : undefined;
  /** Post and stream the reply: text appears as it is written, tool steps as they run. */
  const stream = async (path: string, body: unknown) => {
    setLive({ text: '', steps: [] });
    let result: Conversation | null = null;
    let failure: string | null = null;
    try {
      await apiStream(path, body, (event, data) => {
        if (event === 'text')
          setLive((l) => ({
            text: (l?.text ?? '') + (data as { delta: string }).delta,
            steps: l?.steps ?? [],
          }));
        else if (event === 'tool')
          setLive((l) => ({
            text: l?.text ?? '',
            steps: [...(l?.steps ?? []), (data as { title: string }).title],
          }));
        else if (event === 'done') result = data as Conversation;
        else if (event === 'error') failure = (data as { message: string }).message;
      });
    } finally {
      setLive(null);
    }
    if (failure) throw new Error(failure);
    if (!result) throw new Error('The reply was cut off. Try again.');
    return result as Conversation;
  };
  const done = (c: Conversation) => {
    qc.setQueryData([...key, 'conversation', c.uuid], c);
    setActive(c.uuid);
    void qc.invalidateQueries({ queryKey: [...key, 'conversations'] });
  };
  const send = useMutation({
    mutationFn: (message: string) =>
      active
        ? stream(`/m/assistant/conversations/${active}/messages`, { text: message, context })
        : stream('/m/assistant/conversations', { text: message, context }),
    onSuccess: (c) => {
      setText('');
      done(c);
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const decide = useMutation({
    mutationFn: (decisions: Record<string, boolean>) =>
      stream(`/m/assistant/conversations/${active}/decisions`, { decisions }),
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
    [conv.data?.messages.length, send.isPending, live?.text.length],
  );

  if (loading) return <Skeleton className="h-64" />;
  if (!ready)
    return (
      <Pane>
        <div className="flex flex-col items-center gap-3 py-10 text-center">
          <span
            className="ai-mark flex size-12 items-center justify-center rounded-xl shadow-raised"
            aria-hidden
          >
            <Sparkles className="size-6" />
          </span>
          <p className="font-semibold">The assistant is not set up yet</p>
          <p className="max-w-sm text-sm text-muted">
            {admin
              ? 'Pick an AI provider and paste its API key. It takes about a minute, and several providers are free to start.'
              : 'Ask an admin to set it up.'}
          </p>
          {admin && onSetUp ? (
            <Button variant="primary" onClick={onSetUp}>
              <Sparkles /> Set it up
            </Button>
          ) : null}
        </div>
      </Pane>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim() && !send.isPending) send.mutate(text.trim());
  };
  const proposals = conv.data?.proposals ?? [];
  return (
    <div className={cn('grid gap-4', !compact && 'md:grid-cols-[240px_1fr]')}>
      <Pane padded={false} className={cn('h-fit', compact && 'hidden')}>
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
              <Welcome
                suggestions={[
                  `Which ${(labels.deal?.plural ?? '').toLowerCase()} close this month?`,
                  context
                    ? 'Summarise the history of this record'
                    : `Who are my newest ${(labels.contact?.plural ?? '').toLowerCase()}?`,
                  'What should I follow up on today?',
                  ...(setup ? ['Set up this CRM for my business'] : []),
                ]}
                onPick={(s) => send.mutate(s)}
              />
            ) : conv.isError ? (
              <ErrorState error={conv.error} onRetry={() => void conv.refetch()} />
            ) : (
              conv.data?.messages.map((m, i) => (
                <div
                  key={i}
                  className={cn('anim-rise flex', m.role === 'user' ? 'justify-end' : 'justify-start')}
                >
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
            {live ? (
              <div className="anim-rise flex justify-start" aria-busy="true">
                <div className="ai-surface max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap text-ink">
                  {live.text ? (
                    <span className="ai-caret">{live.text}</span>
                  ) : (
                    <span className="inline-flex items-center gap-2">
                      <span className="ai-dots inline-flex gap-1" aria-hidden>
                        <span />
                        <span />
                        <span />
                      </span>
                      <span className="ai-shimmer">Thinking</span>
                    </span>
                  )}
                  {live.steps.length ? (
                    <ul className="mt-2 flex flex-wrap gap-1">
                      {live.steps.map((step, i) => (
                        <li key={i} className="anim-rise">
                          <Badge tone="outline">
                            <Check className="size-3" aria-hidden /> {step}
                          </Badge>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </div>
            ) : null}
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
    <div className="ai-surface anim-rise rounded-md p-3" role="group" aria-label="Proposed changes">
      <p className="mb-2 text-sm font-medium">
        Confirm {proposals.length === 1 ? 'this change' : 'these changes'}
      </p>
      <ul className="space-y-2">
        {proposals.map((p) => (
          <li key={p.id} className="text-sm">
            <p className="font-medium">{p.title}</p>
            {p.name === 'apply_setup' || p.name === 'add_preset' ? (
              <SetupSummary input={p.input} />
            ) : (
              <pre className="mt-1 overflow-x-auto rounded bg-subtle p-2 text-xs">
                {JSON.stringify(p.input, null, 2)}
              </pre>
            )}
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

/** First screen of a conversation: what the assistant can do, as prompts to start with. */
function Welcome({ suggestions, onPick }: { suggestions: string[]; onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-center gap-4 py-8 text-center">
      <span className="ai-mark flex size-12 items-center justify-center rounded-xl shadow-raised" aria-hidden>
        <Sparkles className="size-6" />
      </span>
      <div>
        <p className="font-semibold">How can I help?</p>
        <p className="text-sm text-muted">Ask about your records, or try one of these.</p>
      </div>
      <ul className="flex max-w-lg flex-wrap justify-center gap-2">
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="rounded-full border border-line bg-surface px-3 py-1.5 text-sm transition-colors duration-150 hover:border-primary hover:bg-primary-soft active:scale-[0.98]"
            >
              {s}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A proposed workspace setup in words: what gets added, by kind. */
function SetupSummary({ input }: { input: Record<string, unknown> }) {
  if (typeof input.key === 'string')
    return <p className="mt-1 text-muted">Add the “{input.key}” preset to this workspace.</p>;
  const setup = (input.setup ?? {}) as {
    vocabulary?: Record<string, { singular: string; plural: string }>;
    custom_fields?: Record<string, { label: string }[]>;
    pipelines?: { name: string; stages: { name: string }[] }[];
    modules?: string[];
    roles?: { name: string }[];
    settings?: Record<string, unknown>;
  };
  const rows: [string, string][] = [];
  for (const [entity, v] of Object.entries(setup.vocabulary ?? {}))
    rows.push(['Rename', `${entity} → ${v.plural}`]);
  for (const [entity, fields] of Object.entries(setup.custom_fields ?? {}))
    rows.push([`Fields on ${entity}`, fields.map((f) => f.label).join(', ')]);
  for (const p of setup.pipelines ?? [])
    rows.push([`Pipeline ${p.name}`, p.stages.map((st) => st.name).join(' → ')]);
  if (setup.modules?.length) rows.push(['Turn on', setup.modules.join(', ')]);
  if (setup.roles?.length) rows.push(['Roles', setup.roles.map((r) => r.name).join(', ')]);
  if (setup.settings) rows.push(['Settings', Object.keys(setup.settings).join(', ')]);
  return (
    <dl className="mt-1 grid gap-1 text-sm">
      {rows.map(([k, v]) => (
        <div key={k + v} className="grid grid-cols-[8rem_1fr] gap-2">
          <dt className="text-muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The side panel opened from the top bar, aware of the record on screen. */
function AssistantPanel({ entity, uuid }: { entity: string; uuid: string }) {
  const status = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () => apiGet<{ name: string; ready: boolean; setup: boolean }>('/m/assistant/status'),
  });
  return (
    <Chat
      ready={!!status.data?.ready}
      loading={status.isPending}
      admin={false}
      setup={!!status.data?.setup}
      compact
      record={uuid ? { entity, uuid } : undefined}
    />
  );
}

const assistantModule: WebModule = {
  key: 'assistant',
  routes: [{ path: '', element: <AssistantPage /> }],
  panels: { chat: ({ entity, uuid }) => <AssistantPanel entity={entity} uuid={uuid} /> },
};
export default assistantModule;
