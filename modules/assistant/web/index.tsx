import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ENTITY_ROUTE, recordTypePath } from '@app/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  Check,
  Copy,
  Eye,
  History,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { WebModule } from '@app/module-sdk';
import { SettingsPanel } from './settings';
import { DECISION_WORDS, thinkingWords } from './thinking';
import { replyHtml, splitNext, type RecordPath } from './markdown';
import type { ReportDefinition, ReportResultDto } from '@app/shared';
import { ReportChart } from '@/features/reports/report-chart';
import { imageFiles, MAX_ATTACHMENTS, prepareImage, type Attachment } from './images';
import { ApiError, apiDelete, apiGet, apiStream, buildUrl } from '@/lib/api';
import { formatRelative } from '@/lib/format';
import { useBoot, useCan } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/input';
import {
  Badge,
  ErrorState,
  Kbd,
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
  /** Configuration changes: what will happen, written by the server. */
  detail?: string;
}
interface Conversation {
  uuid: string;
  title: string;
  messages: {
    role: 'user' | 'assistant';
    text?: string;
    tools?: string[];
    steps?: Step[];
    images?: string[];
    charts?: { title: string; definition: ReportDefinition; result: ReportResultDto }[];
  }[];
  proposals: Proposal[];
}

const key = ['m', 'assistant'] as const;
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';

function AssistantPage() {
  const can = useCan();
  const status = useQuery({
    queryKey: [...key, 'status'],
    queryFn: () =>
      apiGet<{ name: string; ready: boolean; setup: boolean; vision?: boolean }>('/m/assistant/status'),
  });
  const admin = can('assistant.settings.manage');
  const [tab, setTab] = useState('chat');
  const name = status.data?.name ?? 'Assistant';
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={name} />
      <div className="px-4 pb-4 md:px-6">
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
                vision={!!status.data?.vision}
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
            vision={!!status.data?.vision}
            admin={false}
          />
        )}
      </div>
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
  vision = false,
  onSetUp,
}: {
  ready: boolean;
  loading: boolean;
  admin: boolean;
  /** The side panel: no conversation list, the latest conversation only. */
  compact?: boolean;
  /** What is on screen in the side panel: a record, or a list of one type (`uuid` empty). */
  record?: { entity: string; uuid: string };
  /** This person can ask the assistant to set up the workspace. */
  setup?: boolean;
  /** The model reads images: people may attach screenshots. */
  vision?: boolean;
  /** Open the assistant settings (admins, when it is not set up). */
  onSetUp?: () => void;
}) {
  const qc = useQueryClient();
  const boot = useBoot();
  const { labels } = boot;
  const navigate = useNavigate();
  const recordPath: RecordPath = (entity, uuid) => {
    if (entity === 'activity') return null;
    const core = (ENTITY_ROUTE as Record<string, string>)[entity];
    if (core) return `${core}/${uuid}`;
    const type = boot.recordTypes.find((t) => t.entity === entity);
    return type ? `${recordTypePath(type)}/${uuid}` : null;
  };
  /** Record chips in replies open the record inside the app, without reloading it. */
  const openChip = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[data-to]');
    if (!a) return;
    e.preventDefault();
    void navigate(a.dataset.to!);
  };
  const [params] = useSearchParams();
  // What the assistant is saying right now, and the steps it is taking, while a reply streams in.
  const [live, setLive] = useState<{ text: string; steps: string[]; words: string[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [search, setSearch] = useState('');
  /** The person is editing their last question in the message box. */
  const [editing, setEditing] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  /** Adds pasted, dropped or picked images (shrunk first); explains why when they cannot be used. */
  const attach = async (files: File[]) => {
    if (!files.length) return;
    if (!vision) {
      toast.error('This assistant reads text only, so images cannot be attached.');
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0 || files.length > room) toast.error(`Attach up to ${MAX_ATTACHMENTS} images per question.`);
    for (const file of files.slice(0, Math.max(0, room))) {
      try {
        const a = await prepareImage(file);
        setAttachments((list) => (list.length < MAX_ATTACHMENTS ? [...list, a] : list));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'The image could not be added.');
      }
    }
  };
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
  const messages = conv.data?.messages ?? [];
  const lastQuestionAt = messages.findLastIndex((m) => m.role === 'user');
  const lastQuestion = lastQuestionAt >= 0 ? messages[lastQuestionAt] : undefined;
  // The page on screen (side panel) or `?about=contact:<uuid>` from a record page: ids only, the
  // assistant reads the rest with its tools. The person can leave it out of the next question.
  const about = params.get('about');
  const onScreen = record?.entity
    ? { entity: record.entity, ...(record.uuid ? { uuid: record.uuid } : {}) }
    : about && /^[a-z_]+:[0-9a-f-]{36}$/.test(about)
      ? { entity: about.split(':')[0]!, uuid: about.split(':')[1]! }
      : undefined;
  const pageKey = onScreen ? `${onScreen.entity}:${onScreen.uuid ?? ''}` : '';
  const [skipped, setSkipped] = useState('');
  const context = onScreen && skipped !== pageKey ? onScreen : undefined;
  const label = context ? labels[context.entity] : undefined;
  const contextName = context
    ? context.uuid
      ? `This ${(label?.singular ?? 'record').toLowerCase()}`
      : `${label?.plural ?? 'Records'} list`
    : '';
  const contextAsk = context
    ? context.uuid
      ? `Ask about this ${(label?.singular ?? 'record').toLowerCase()}…`
      : `Ask about these ${(label?.plural ?? 'records').toLowerCase()}…`
    : 'Ask anything about your records';
  /** Post and stream the reply: text appears as it is written, tool steps as they run. */
  const stopper = useRef<AbortController | null>(null);
  const stream = async (path: string, body: unknown, words: string[]) => {
    setLive({ text: '', steps: [], words });
    let result: Conversation | null = null;
    let failure: string | null = null;
    const stop = new AbortController();
    stopper.current = stop;
    try {
      await apiStream(
        path,
        body,
        (event, data) => {
          if (event === 'text')
            setLive((l) => ({
              text: (l?.text ?? '') + (data as { delta: string }).delta,
              steps: l?.steps ?? [],
              words: l?.words ?? [],
            }));
          else if (event === 'tool')
            setLive((l) => ({
              text: l?.text ?? '',
              steps: [...(l?.steps ?? []), (data as { title: string }).title],
              words: l?.words ?? [],
            }));
          else if (event === 'done') result = data as Conversation;
          else if (event === 'error') failure = (data as { message: string }).message;
        },
        stop.signal,
      );
    } catch (err) {
      if (stop.signal.aborted) throw new Stopped();
      throw err;
    } finally {
      stopper.current = null;
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
    mutationFn: ({ text: message, images = [] }: Question) => {
      const body = {
        text: message,
        context,
        ...(images.length ? { images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })) } : {}),
      };
      return active
        ? stream(`/m/assistant/conversations/${active}/messages`, body, thinkingWords(message, labels))
        : stream('/m/assistant/conversations', body, thinkingWords(message, labels));
    },
    // The question leaves the box as soon as it is sent, and comes back if sending fails.
    onMutate: () => {
      setText('');
      setAttachments([]);
    },
    onSuccess: (c) => done(c),
    onError: (err, { text: message, images = [] }) => {
      // Stopped on purpose: the question was saved, so show the conversation as the server has it.
      if (err instanceof Stopped) {
        void qc.invalidateQueries({ queryKey: key });
        return;
      }
      setText((t) => t || message);
      setAttachments((a) => (a.length ? a : images));
      toast.error(errorText(err));
    },
  });
  // Ask the last question again: as it was (retry) or edited (with text).
  const again = useMutation({
    mutationFn: (edited?: string) =>
      stream(
        `/m/assistant/conversations/${active}/retry`,
        edited === undefined ? {} : { text: edited },
        thinkingWords(edited ?? lastQuestion?.text ?? '', labels),
      ),
    onMutate: () => {
      setEditing(false);
      setText('');
    },
    onSuccess: (c) => done(c),
    onError: (err) => {
      if (err instanceof Stopped) void qc.invalidateQueries({ queryKey: key });
      else toast.error(errorText(err));
    },
  });
  const decide = useMutation({
    mutationFn: (decisions: Record<string, boolean>) =>
      stream(`/m/assistant/conversations/${active}/decisions`, { decisions }, DECISION_WORDS),
    onSuccess: (c) => {
      done(c);
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'm' });
    },
    onError: (err) => {
      if (err instanceof Stopped) void qc.invalidateQueries({ queryKey: key });
      else toast.error(errorText(err));
    },
  });
  const remove = useMutation({
    mutationFn: (uuid: string) => apiDelete(`/m/assistant/conversations/${uuid}`),
    onSettled: () => void qc.invalidateQueries({ queryKey: [...key, 'conversations'] }),
    onError: (err) => toast.error(errorText(err)),
  });
  // A deleted conversation disappears at once and is removed for good a few seconds later, unless undone.
  const [deleting, setDeleting] = useState<string[]>([]);
  const deleteLater = (uuid: string) => {
    setDeleting((d) => [...d, uuid]);
    if (uuid === active) setActive(null);
    const timer = setTimeout(() => remove.mutate(uuid), UNDO_MS);
    toast.success('Deleted', {
      duration: UNDO_MS,
      action: {
        label: 'Undo',
        onClick: () => {
          clearTimeout(timer);
          setDeleting((d) => d.filter((x) => x !== uuid));
        },
      },
    });
  };
  const bottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  // The box grows with the question, up to its max height, and shrinks back after sending.
  useEffect(() => {
    const el = composer.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text]);
  useEffect(() => {
    // A block, not an expression: newer browsers return a Promise here, which React would call as cleanup.
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [conv.data?.messages.length, send.isPending, live?.text.length]);

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
    if (editing) {
      if (text.trim() && !again.isPending) again.mutate(text.trim());
      return;
    }
    if (send.isPending || (!text.trim() && !attachments.length)) return;
    // An image on its own still needs a question for the model.
    send.mutate({ text: text.trim() || 'What does this image show?', images: attachments });
  };
  const proposals = conv.data?.proposals ?? [];
  const busy = send.isPending || decide.isPending || again.isPending;
  const last = conv.data?.messages.at(-1);
  // What the person might ask next, offered under the latest answer.
  const next =
    last?.role === 'assistant' && last.text && !live && !proposals.length ? splitNext(last.text).next : [];
  const q = search.trim().toLowerCase();
  const shown = (list.data ?? []).filter(
    (c) => !deleting.includes(c.uuid) && (!q || c.title.toLowerCase().includes(q)),
  );
  const history = (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-line p-2">
        <label className="flex items-center gap-2 rounded-sm border border-line bg-canvas px-2 focus-within:border-primary">
          <Search className="size-4 text-faint" aria-hidden />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="h-8 min-w-0 flex-1 bg-transparent text-sm outline-none pointer-coarse:text-base"
          />
        </label>
      </div>
      {list.isPending ? (
        <Skeleton className="m-3 h-16" />
      ) : list.isError ? (
        <ErrorState error={list.error} onRetry={() => void list.refetch()} />
      ) : !shown.length ? (
        <p className="p-3 text-sm text-muted">{q ? 'No conversations match.' : 'No conversations yet.'}</p>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 [scrollbar-gutter:stable]">
          {byDay(shown).map(([day, items]) => (
            <section key={day} aria-label={day}>
              <h3 className="px-3 pt-3 pb-1 text-xs font-medium text-faint">{day}</h3>
              <ul>
                {items.map((c) => (
                  <li key={c.uuid} className="group relative">
                    <button
                      type="button"
                      onClick={() => {
                        setActive(c.uuid);
                        setShowHistory(false);
                      }}
                      aria-current={c.uuid === active ? 'true' : undefined}
                      className={cn(
                        'block w-full rounded-sm py-1.5 ps-3 pe-10 text-start text-sm transition-colors duration-150 hover:bg-subtle',
                        c.uuid === active && 'bg-primary-soft font-medium text-ink hover:bg-primary-soft',
                      )}
                    >
                      <span className="block truncate">{c.title}</span>
                      <span className="text-xs font-normal text-faint">{formatRelative(c.updatedAt)}</span>
                    </button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
                      aria-label={`Delete ${c.title}`}
                      title="Delete"
                      onClick={() => deleteLater(c.uuid)}
                    >
                      <Trash2 />
                    </Button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
  return (
    // Measures the room the chat has, so its layout follows that rather than the window.
    <div className={compact ? 'contents' : '@container'}>
      <div
        className={cn(
          compact
            ? '-m-4 flex min-h-0 flex-1 flex-col'
            : // Laid out by the room it has (a docked panel can take some), not by the window.
              'grid h-[calc(100dvh-13.5rem)] min-h-[28rem] gap-4 @3xl:grid-cols-[260px_1fr]',
        )}
      >
        {compact ? null : (
          <section className="hidden min-h-0 flex-col rounded-md border border-line bg-surface shadow-raised @3xl:flex">
            <div className="border-b border-line p-2">
              <Button variant="primary" className="w-full" onClick={() => setActive(null)}>
                <MessageSquarePlus /> New conversation
              </Button>
            </div>
            {history}
          </section>
        )}
        <ChatFrame compact={compact}>
          <div className="flex min-h-0 flex-1 flex-col">
            {/* In the side panel, and on small screens where the page hides its history column. */}
            <div
              className={cn(
                'flex items-center gap-1 border-b border-line px-2 py-1',
                !compact && '@3xl:hidden',
              )}
            >
              <Button
                size="sm"
                variant={showHistory ? 'subtle' : 'ghost'}
                aria-pressed={showHistory}
                onClick={() => setShowHistory((v) => !v)}
              >
                <History /> History
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="ms-auto"
                onClick={() => {
                  setActive(null);
                  setShowHistory(false);
                }}
              >
                <MessageSquarePlus /> New
              </Button>
            </div>
            {showHistory ? (
              <div className="min-h-0 flex-1 overflow-y-auto">{history}</div>
            ) : (
              <>
                <div className="min-h-0 flex-1 overflow-y-auto p-4" aria-live="polite">
                  <div className={cn('space-y-3', !compact && 'mx-auto w-full max-w-3xl')}>
                    {!active && !send.isPending ? (
                      <Welcome
                        compact={compact}
                        suggestions={suggestionsFor(context, labels, setup)}
                        onPick={(s) => send.mutate({ text: s })}
                      />
                    ) : conv.isError ? (
                      <ErrorState error={conv.error} onRetry={() => void conv.refetch()} />
                    ) : (
                      (again.isPending ? messages.slice(0, lastQuestionAt + 1) : messages).map((m, i) =>
                        m.role === 'user' ? (
                          <div key={i} className="group anim-rise flex items-end justify-end gap-1">
                            {i === lastQuestionAt && !busy && !proposals.length ? (
                              <div className="flex opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  aria-label="Edit question"
                                  title="Edit and ask again"
                                  onClick={() => {
                                    setEditing(true);
                                    setText(m.text ?? '');
                                    composer.current?.focus();
                                  }}
                                >
                                  <Pencil />
                                </Button>
                              </div>
                            ) : null}
                            <div className="max-w-[85%] min-w-0 rounded-lg rounded-ee-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-fg">
                              <BubbleImages srcs={(m.images ?? []).map((p) => buildUrl(p))} />
                              {again.isPending && again.variables !== undefined && i === lastQuestionAt
                                ? again.variables
                                : m.text}
                            </div>
                          </div>
                        ) : (
                          <div key={i} className="group anim-rise flex gap-2">
                            <AssistantAvatar />
                            <div className="relative max-w-[calc(100%-4rem)] min-w-0">
                              <div className="rounded-lg rounded-ss-sm bg-subtle px-3 py-2 text-sm text-ink">
                                {m.tools?.length ? (
                                  <ul
                                    className={cn(
                                      'flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-faint',
                                      m.text && 'mb-1.5',
                                    )}
                                    aria-label="Steps taken"
                                  >
                                    {(m.steps ?? m.tools.map((title): Step => ({ title }))).map((st, k) => (
                                      <li key={k} className="inline-flex items-center gap-1">
                                        <Check className="size-3" aria-hidden />
                                        {st.title}
                                        {st.entity ? (
                                          <span className="text-muted">
                                            · {labels[st.entity]?.plural ?? st.entity}
                                          </span>
                                        ) : null}
                                        {st.query ? <span className="text-muted">· “{st.query}”</span> : null}
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                                {m.text ? (
                                  <div
                                    className="rte-prose ai-reply"
                                    onClick={openChip}
                                    dangerouslySetInnerHTML={{
                                      __html: replyHtml(splitNext(m.text).body, recordPath),
                                    }}
                                  />
                                ) : null}
                                {(m.charts ?? []).map((c, k) => (
                                  <figure
                                    key={k}
                                    className="mt-3 rounded-md border border-line bg-surface p-3"
                                    aria-label={c.title || 'Chart'}
                                  >
                                    {c.title ? (
                                      <figcaption className="mb-2 text-xs font-medium text-muted">
                                        {c.title}
                                      </figcaption>
                                    ) : null}
                                    <ReportChart result={c.result} definition={c.definition} height={220} />
                                  </figure>
                                ))}
                              </div>
                              {m.text ? (
                                // Shown on hover or keyboard focus; always on touch screens, which cannot hover.
                                <div className="absolute -end-9 bottom-0 flex flex-col opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
                                  {i === messages.length - 1 && !busy ? (
                                    <Button
                                      size="icon-sm"
                                      variant="ghost"
                                      aria-label="Ask again"
                                      title="Ask again for a new answer"
                                      onClick={() => again.mutate(undefined)}
                                    >
                                      <RotateCcw />
                                    </Button>
                                  ) : null}
                                  <Button
                                    size="icon-sm"
                                    variant="ghost"
                                    aria-label="Copy answer"
                                    title="Copy answer"
                                    onClick={() => void copy(splitNext(m.text!).body)}
                                  >
                                    <Copy />
                                  </Button>
                                </div>
                              ) : null}
                            </div>
                          </div>
                        ),
                      )
                    )}
                    {lastQuestionAt === messages.length - 1 && lastQuestion && !busy && !proposals.length ? (
                      <div className="flex items-center gap-2 ps-8 text-sm text-muted" role="status">
                        No answer yet.
                        <Button size="sm" variant="ghost" onClick={() => again.mutate(undefined)}>
                          <RotateCcw /> Ask again
                        </Button>
                      </div>
                    ) : null}
                    {send.isPending && send.variables ? (
                      <div className="anim-rise flex justify-end">
                        <div className="max-w-[85%] rounded-lg rounded-ee-sm bg-primary px-3 py-2 text-sm whitespace-pre-wrap text-primary-fg">
                          <BubbleImages srcs={(send.variables.images ?? []).map((i) => i.preview)} />
                          {send.variables.text}
                        </div>
                      </div>
                    ) : null}
                    {live ? (
                      <div className="anim-rise flex gap-2" aria-busy="true">
                        <AssistantAvatar />
                        <div className="ai-surface max-w-[92%] min-w-0 rounded-lg rounded-ss-sm px-3 py-2 text-sm text-ink">
                          {live.text ? (
                            <div
                              className="rte-prose ai-reply ai-caret-md"
                              dangerouslySetInnerHTML={{
                                __html: replyHtml(
                                  splitNext(live.text).body.replace(
                                    /```chart[\s\S]*?(```|$)/g,
                                    '_Drawing a chart…_',
                                  ),
                                  recordPath,
                                ),
                              }}
                            />
                          ) : (
                            <span className="inline-flex items-center gap-2">
                              <span className="ai-dots inline-flex gap-1" aria-hidden>
                                <span />
                                <span />
                                <span />
                              </span>
                              <RotatingWords words={live.words} />
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
                    {next.length ? (
                      <ul
                        className="anim-rise flex flex-wrap gap-1.5 ps-8"
                        aria-label="Suggested next questions"
                      >
                        {next.map((q) => (
                          <li key={q}>
                            <button
                              type="button"
                              className="ai-chip ai-chip-next"
                              disabled={send.isPending}
                              onClick={() => send.mutate({ text: q })}
                            >
                              {q}
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {proposals.length ? (
                      <Proposals
                        proposals={proposals}
                        onDecide={(d) => decide.mutate(d)}
                        busy={decide.isPending}
                      />
                    ) : null}
                    <div ref={bottom} />
                  </div>
                </div>
                <form onSubmit={submit} className="border-t border-line p-3">
                  {editing ? (
                    <div className="mb-2 flex items-center gap-1 text-xs text-muted" role="status">
                      <Pencil className="size-3" aria-hidden /> Editing your last question; its answer will be
                      replaced.
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="ms-auto"
                        onClick={() => {
                          setEditing(false);
                          setText('');
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  ) : null}
                  {context ? (
                    <div className="mb-2 flex items-center gap-1">
                      <span className="inline-flex items-center gap-1 rounded-full border border-line bg-subtle py-0.5 ps-2 pe-0.5 text-xs text-muted">
                        <Eye className="size-3" aria-hidden />
                        <span>
                          Using: <span className="font-medium text-ink">{contextName}</span>
                        </span>
                        <button
                          type="button"
                          className="rounded-full p-0.5 hover:bg-hover"
                          aria-label={`Leave out ${contextName.toLowerCase()}`}
                          title="Leave this page out of the question"
                          onClick={() => setSkipped(pageKey)}
                        >
                          <X className="size-3" />
                        </button>
                      </span>
                    </div>
                  ) : null}
                  {attachments.length ? (
                    <ul className="mb-2 flex flex-wrap gap-2" aria-label="Attached images">
                      {attachments.map((a, i) => (
                        <li key={a.id} className="anim-rise relative">
                          <img
                            src={a.preview}
                            alt={`Attached image ${i + 1}: ${a.name}`}
                            className="size-16 rounded-md border border-line object-cover"
                          />
                          <button
                            type="button"
                            className="absolute -end-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-raised hover:text-ink pointer-coarse:size-7"
                            aria-label={`Remove image ${i + 1}`}
                            onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}
                          >
                            <X className="size-3" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <div
                    onDragOver={(e) => {
                      if (!vision || ![...e.dataTransfer.types].includes('Files')) return;
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      if (!vision) return;
                      e.preventDefault();
                      setDragging(false);
                      void attach(imageFiles(e.dataTransfer.files));
                    }}
                    className={cn(
                      'flex items-end gap-1 rounded-md border border-line bg-surface p-1 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary-soft',
                      dragging && 'border-primary bg-primary-soft',
                    )}
                  >
                    {vision ? (
                      <>
                        <input
                          ref={fileInput}
                          type="file"
                          accept="image/png,image/jpeg,image/webp,image/gif"
                          multiple
                          hidden
                          onChange={(e) => {
                            void attach(imageFiles(e.target.files));
                            e.target.value = '';
                          }}
                        />
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          aria-label="Attach images"
                          title="Attach images, or paste a screenshot"
                          disabled={attachments.length >= MAX_ATTACHMENTS || proposals.length > 0}
                          onClick={() => fileInput.current?.click()}
                        >
                          <Paperclip />
                        </Button>
                      </>
                    ) : null}
                    <Textarea
                      ref={composer}
                      autoFocus={compact}
                      value={text}
                      rows={1}
                      onChange={(e) => setText(e.target.value)}
                      onPaste={(e) => {
                        const files = imageFiles(e.clipboardData.files);
                        if (!files.length) return;
                        e.preventDefault();
                        void attach(files);
                      }}
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
                        // Ctrl, Cmd or the Windows key + Enter add a line (the browser does not by itself).
                        if (e.ctrlKey || e.metaKey) {
                          e.preventDefault();
                          const el = e.currentTarget;
                          el.setRangeText('\n', el.selectionStart, el.selectionEnd, 'end');
                          setText(el.value);
                          return;
                        }
                        // Enter sends; Shift+Enter adds a line on its own.
                        if (!e.shiftKey) {
                          e.preventDefault();
                          e.currentTarget.form?.requestSubmit();
                        }
                      }}
                      placeholder={contextAsk}
                      aria-label="Message"
                      aria-describedby={compact ? undefined : 'composer-hint'}
                      className="max-h-40 min-h-9 flex-1 resize-none border-0 bg-transparent px-1.5 py-2 leading-5 shadow-none focus-visible:ring-0 focus-visible:outline-none"
                      disabled={proposals.length > 0}
                      maxLength={4000}
                    />
                    {busy ? (
                      <Button type="button" size="sm" onClick={() => stopper.current?.abort()}>
                        <Square /> Stop
                      </Button>
                    ) : (
                      <Button
                        type="submit"
                        size="sm"
                        variant="primary"
                        disabled={(!text.trim() && !attachments.length) || proposals.length > 0}
                        aria-label="Send"
                      >
                        <Send />
                      </Button>
                    )}
                  </div>
                  {compact ? null : (
                    <p id="composer-hint" className="mt-1.5 hidden text-xs text-faint @xl:block">
                      <Kbd>Enter</Kbd> to send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> for a new line
                      {vision ? ' · paste or drop screenshots' : ''}
                    </p>
                  )}
                </form>
              </>
            )}
          </div>
        </ChatFrame>
      </div>
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
            ) : p.name === 'config_change' ? (
              <ConfigSummary input={p.input} detail={p.detail} />
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

type Labels = Record<string, { singular: string; plural: string } | undefined>;

/** Starting questions that fit the page on screen: a record, a list, or anywhere. */
function suggestionsFor(
  context: { entity: string; uuid?: string } | undefined,
  labels: Labels,
  setup: boolean,
): string[] {
  const lower = (s?: string) => (s ?? '').toLowerCase();
  const deals = lower(labels.deal?.plural) || 'deals';
  if (context?.uuid) {
    const one = lower(labels[context.entity]?.singular) || 'record';
    return [
      `Summarise this ${one}`,
      `What should I do next on this ${one}?`,
      `What changed on this ${one} recently?`,
      'Draft a follow-up email',
    ];
  }
  if (context) {
    const many = lower(labels[context.entity]?.plural) || 'records';
    return [
      `Which ${many} need attention?`,
      `Show my newest ${many}`,
      `How many ${many} were added this month?`,
      'What should I follow up on today?',
    ];
  }
  return [
    `Which ${deals} close this month?`,
    `Who are my newest ${lower(labels.contact?.plural) || 'contacts'}?`,
    'What should I follow up on today?',
    ...(setup ? ['Set up this CRM for my business'] : ['Summarise my week']),
  ];
}

/** First screen of a conversation: what the assistant can do, as questions to start with. */
function Welcome({
  suggestions,
  onPick,
  compact,
}: {
  suggestions: string[];
  onPick: (text: string) => void;
  compact: boolean;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-4 text-center', compact ? 'py-4' : 'py-10')}>
      <span className="ai-mark flex size-12 items-center justify-center rounded-xl shadow-raised" aria-hidden>
        <Sparkles className="size-6" />
      </span>
      <div>
        <p className="font-semibold">How can I help?</p>
        <p className="text-sm text-muted">Ask about your records, or start with one of these.</p>
      </div>
      <ul
        className={cn('grid w-full gap-2 text-start', compact ? 'grid-cols-1' : 'max-w-2xl sm:grid-cols-2')}
      >
        {suggestions.map((s) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => onPick(s)}
              className="group flex w-full items-center gap-2 rounded-md text-start border border-line bg-surface px-3 py-2.5 text-sm transition-[border-color,background-color,transform] duration-150 ease-out hover:border-primary hover:bg-primary-soft active:scale-[0.99]"
            >
              <MessageSquare className="size-4 shrink-0 text-faint group-hover:text-primary" aria-hidden />
              <span className="flex-1">{s}</span>
              <ArrowRight
                className="size-4 shrink-0 text-faint transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-primary rtl:rotate-180"
                aria-hidden
              />
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
    queryFn: () =>
      apiGet<{ name: string; ready: boolean; setup: boolean; vision?: boolean }>('/m/assistant/status'),
  });
  return (
    <Chat
      ready={!!status.data?.ready}
      loading={status.isPending}
      admin={false}
      setup={!!status.data?.setup}
      vision={!!status.data?.vision}
      compact
      record={entity ? { entity, uuid } : undefined}
    />
  );
}

const assistantModule: WebModule = {
  key: 'assistant',
  routes: [{ path: '', element: <AssistantPage /> }],
  panels: { chat: ({ entity, uuid }) => <AssistantPanel entity={entity} uuid={uuid} /> },
};
export default assistantModule;

/** A card on the assistant page; in the side panel the chat fills the panel instead. */
function ChatFrame({ compact, children }: { compact: boolean; children: ReactNode }) {
  return compact ? (
    <div className="flex min-h-0 flex-1 flex-col">{children}</div>
  ) : (
    <section className="flex min-h-0 flex-col rounded-md border border-line bg-surface shadow-raised">
      {children}
    </section>
  );
}

/** Short status lines, one at a time, while the reply is being worked out. */
function RotatingWords({ words }: { words: string[] }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (words.length < 2) return;
    // Stops on the last line instead of looping back to the start.
    const t = setInterval(() => setI((n) => Math.min(n + 1, words.length - 1)), 1800);
    return () => clearInterval(t);
  }, [words]);
  return (
    <>
      <span key={i} className="ai-shimmer anim-rise" aria-hidden>
        {words[i] ?? 'Thinking'}
      </span>
      <span className="sr-only">Thinking</span>
    </>
  );
}

/** Conversations under Today, Yesterday, This week and Earlier, newest first. */
function byDay<T extends { updatedAt: string }>(items: T[]): [string, T[]][] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const at = new Date(item.updatedAt).getTime();
    const name =
      at >= start.getTime()
        ? 'Today'
        : at >= start.getTime() - day
          ? 'Yesterday'
          : at >= start.getTime() - 6 * day
            ? 'This week'
            : 'Earlier';
    groups.set(name, [...(groups.get(name) ?? []), item]);
  }
  return [...groups.entries()];
}

/** A step the assistant took, with the record type or search it looked at. */
interface Step {
  title: string;
  entity?: string;
  query?: string;
}

interface Question {
  text: string;
  images?: Attachment[];
}

/** Images a person attached, above their words; each opens full size in a new tab. */
function BubbleImages({ srcs }: { srcs: string[] }) {
  if (!srcs.length) return null;
  return (
    <span className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {srcs.map((src, i) => (
        <a key={src} href={src} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={src}
            alt={`Attached image ${i + 1}`}
            loading="lazy"
            className="max-h-40 max-w-full rounded-md border border-primary-fg/20 object-contain"
          />
        </a>
      ))}
    </span>
  );
}

/** Marks the assistant's side of the conversation, so replies scan apart from questions. */
function AssistantAvatar() {
  return (
    <span
      className="ai-mark mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full"
      aria-hidden
    >
      <Sparkles className="size-3.5" />
    </span>
  );
}

/** Raised when the person stops a reply on purpose. */
class Stopped extends Error {}

const UNDO_MS = 5000;

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('Copied');
  } catch {
    toast.error('Could not copy. Select the text and copy it instead.');
  }
}

/**
 * A configuration change: what the server says will happen and the exact change, always visible.
 * The assistant's own words come last and are labelled as such, since a model can be misled.
 */
function ConfigSummary({ input, detail }: { input: Record<string, unknown>; detail?: string }) {
  const method = String(input.method ?? '').toUpperCase();
  return (
    <div className="mt-1 space-y-1.5">
      {detail ? <p className="font-medium">{detail}</p> : null}
      <p className="text-xs text-muted">
        {method} {String(input.path ?? '')}
      </p>
      <pre className="max-h-48 overflow-auto rounded bg-subtle p-2 text-xs">
        {JSON.stringify(input.body ?? {}, null, 2)}
      </pre>
      {input.summary ? <p className="text-xs text-muted">Assistant's note: {String(input.summary)}</p> : null}
    </div>
  );
}
