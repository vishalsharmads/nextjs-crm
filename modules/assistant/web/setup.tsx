import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  BarChart3,
  Check,
  CircleAlert,
  Globe,
  Hammer,
  Layers,
  Lightbulb,
  ListChecks,
  Palette,
  Plus,
  RefreshCw,
  Send,
  SkipForward,
  Sparkles,
  Tags,
  Trash2,
  Users,
  Wand2,
  Workflow,
} from 'lucide-react';
import { Link } from 'react-router';
import { Checkbox } from '@/components/ui/checkbox';
import { DataStep } from './setup-data';
import { ChangePreview, pathKey, type ChangeEdits, type ChangePreviewDto } from './change-preview';
import { ApiError, apiGet, apiPost, apiPut } from '@/lib/api';
import { useBoot } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Badge, ErrorState, PageHeader, Pane, Skeleton } from '@/components/ui/misc';

/** Phase 10: the business tells its story, the assistant interviews it and writes a brief. */
interface Turn {
  done: boolean;
  question: string;
  why: string;
  suggestions: string[];
  multi: boolean;
  answer?: string;
}
type Entity = 'contact' | 'organization' | 'deal' | 'lead';
interface Brief {
  businessName: string;
  summary: string;
  industry: string;
  presetKey: string | null;
  offerings: string[];
  customerTypes: string[];
  channels: string[];
  stages: { name: string; description?: string }[];
  track: { entity: Entity; label: string; type: string; options?: string[] }[];
  roles: { name: string; does?: string }[];
  vocabulary: Partial<Record<Entity, { singular: string; plural: string }>>;
  problems: string[];
  reports: string[];
  automations: string[];
}
interface Profile {
  businessName: string;
  website?: string;
  industry?: string;
  offerings?: string;
  customers?: string;
  channels?: string;
  process?: string;
  team?: string;
  tools?: string;
  problems?: string;
  notes?: string;
}
interface Session {
  uuid: string;
  step: string;
  profile: Profile | null;
  website: {
    url: string;
    name: string | null;
    description: string | null;
    logos: string[];
    colors: string[];
  } | null;
  interview: Turn[];
  brief: Brief | null;
  proposal: { items: ProposalItem[] } | null;
  built: { results: { area: string; ok: boolean; message: string }[]; at: string } | null;
}

interface ProposalItem {
  id: string;
  area: string;
  title: string;
  detail?: string;
  advice?: boolean;
  preview: ChangePreviewDto;
  payload: Record<string, unknown>;
}

const key = ['m', 'assistant', 'setup'] as const;
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';

const STEPS = [
  { id: 'profile', label: 'Your business' },
  { id: 'interview', label: 'Questions' },
  { id: 'brief', label: 'Brief' },
  { id: 'proposal', label: 'Setup' },
  { id: 'built', label: 'Done' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

export function SetupPage() {
  const qc = useQueryClient();
  const latest = useQuery({
    queryKey: [...key, 'latest'],
    queryFn: () => apiGet<{ session: Session | null }>('/m/assistant/setup/latest').then((r) => r.session),
  });
  const [view, setView] = useState<StepId | null>(null);
  const session = latest.data;
  const put = (s: Session) => qc.setQueryData([...key, 'latest'], s);
  const start = useMutation({
    mutationFn: () => apiPost<Session>('/m/assistant/setup'),
    onSuccess: (s) => {
      put(s);
      setView('profile');
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const step: StepId = view ?? (session?.step as StepId | undefined) ?? 'profile';
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Set up with AI"
        description="Tell the assistant about your business. It asks a few questions, writes a brief for you to check, then proposes a setup you choose from."
        actions={
          session ? (
            <Button variant="ghost" size="sm" onClick={() => start.mutate()} loading={start.isPending}>
              <RefreshCw /> Start over
            </Button>
          ) : null
        }
      />
      <div className="px-4 pb-6 md:px-6">
        {latest.isPending ? (
          <Skeleton className="h-64" />
        ) : latest.isError ? (
          <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
        ) : !session ? (
          <Pane>
            <div className="flex flex-col items-center gap-3 py-10 text-center">
              <span
                className="ai-mark flex size-12 items-center justify-center rounded-xl shadow-raised"
                aria-hidden
              >
                <Wand2 className="size-6" />
              </span>
              <p className="font-semibold">Build your CRM around how you work</p>
              <p className="max-w-md text-sm text-muted">
                About ten minutes: your business, a few questions, a brief to check, then a setup to choose
                from. Nothing changes until you approve it.
              </p>
              <Button variant="primary" onClick={() => start.mutate()} loading={start.isPending}>
                <Sparkles /> Start
              </Button>
            </div>
          </Pane>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <Stepper current={step} reached={session.step as StepId} onPick={setView} />
            {step === 'profile' ? (
              <ProfileStep session={session} onSaved={put} onNext={() => setView('interview')} />
            ) : step === 'interview' ? (
              <InterviewStep session={session} onSaved={put} onNext={() => setView('brief')} />
            ) : step === 'brief' ? (
              <BriefStep session={session} onSaved={put} onNext={() => setView('proposal')} />
            ) : step === 'proposal' ? (
              <ProposalStep session={session} onSaved={put} onNext={() => setView('built')} />
            ) : (
              <>
                <BuiltStep session={session} />
                <DataStep sessionUuid={session.uuid} />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Stepper({
  current,
  reached,
  onPick,
}: {
  current: StepId;
  reached: StepId;
  onPick: (s: StepId) => void;
}) {
  const reachedAt = STEPS.findIndex((s) => s.id === reached);
  return (
    <ol className="flex flex-wrap items-center gap-1 text-sm" aria-label="Setup steps">
      {STEPS.map((s, i) => {
        const open = i <= Math.max(reachedAt, 0);
        return (
          <li key={s.id} className="flex items-center gap-1">
            <button
              type="button"
              disabled={!open}
              onClick={() => onPick(s.id)}
              aria-current={s.id === current ? 'step' : undefined}
              className={cn(
                'flex items-center gap-1.5 rounded-full px-3 py-1 transition-colors duration-150',
                s.id === current
                  ? 'bg-primary text-primary-fg'
                  : open
                    ? 'bg-subtle text-ink hover:bg-hover'
                    : 'text-faint',
              )}
            >
              <span className="tabular text-xs">{i + 1}</span> {s.label}
            </button>
            {i < STEPS.length - 1 ? (
              <ArrowRight className="size-3.5 text-faint rtl:rotate-180" aria-hidden />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

const PROFILE_FIELDS: { key: keyof Profile; label: string; help: string; long?: boolean }[] = [
  {
    key: 'industry',
    label: 'Industry',
    help: 'For example: dental clinic, recruitment agency, software company.',
  },
  { key: 'offerings', label: 'What you sell or provide', help: 'Products, services, packages.', long: true },
  {
    key: 'customers',
    label: 'Who your customers are',
    help: 'Types of customers, sizes, regions.',
    long: true,
  },
  {
    key: 'channels',
    label: 'How customers find you',
    help: 'Website, referrals, events, ads, walk-ins…',
    long: true,
  },
  {
    key: 'process',
    label: 'Your process, step by step',
    help: 'From first contact to a happy, paying customer.',
    long: true,
  },
  { key: 'team', label: 'Your team', help: 'Who works with customers, and what each does.', long: true },
  { key: 'tools', label: 'What you use today', help: 'Spreadsheets, another CRM, email, paper…', long: true },
  { key: 'problems', label: 'What goes wrong today', help: 'What you want this CRM to fix.', long: true },
  { key: 'notes', label: 'Anything else', help: 'Rules, wishes, words you use.', long: true },
];

function ProfileStep({
  session,
  onSaved,
  onNext,
}: {
  session: Session;
  onSaved: (s: Session) => void;
  onNext: () => void;
}) {
  const [p, setP] = useState<Profile>(session.profile ?? { businessName: '' });
  const set = (k: keyof Profile, v: string) => setP((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => apiPut<Session>(`/m/assistant/setup/${session.uuid}/profile`, p),
    onSuccess: onSaved,
    onError: (err) => toast.error(errorText(err)),
  });
  const read = useMutation({
    mutationFn: async () => {
      await apiPut(`/m/assistant/setup/${session.uuid}/profile`, p);
      return apiPost<Session>(`/m/assistant/setup/${session.uuid}/website`);
    },
    onSuccess: (s) => {
      onSaved(s);
      toast.success('Website read');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const site = session.website;
  return (
    <Pane title="Your business">
      <div className="grid gap-4">
        <Field label="Business name" required>
          {(f) => (
            <Input {...f} value={p.businessName} onChange={(e) => set('businessName', e.target.value)} />
          )}
        </Field>
        <Field
          label="Website"
          help="The assistant reads your home page once to learn your name, logo, colours and what you do."
        >
          {(f) => (
            <div className="flex gap-2">
              <Input
                {...f}
                value={p.website ?? ''}
                onChange={(e) => set('website', e.target.value)}
                placeholder="www.example.com"
                inputMode="url"
              />
              <Button
                type="button"
                onClick={() => read.mutate()}
                loading={read.isPending}
                disabled={!p.website?.trim() || !p.businessName.trim()}
              >
                <Globe /> Read website
              </Button>
            </div>
          )}
        </Field>
        {site ? (
          <div className="anim-rise flex flex-wrap items-start gap-4 rounded-md border border-line bg-subtle p-3 text-sm">
            {site.logos[0] ? (
              <img
                src={site.logos[0]}
                alt="Logo found on the website"
                className="size-12 rounded-md bg-surface object-contain p-1"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <p className="font-medium">{site.name ?? 'Name not found'}</p>
              {site.description ? <p className="text-muted">{site.description}</p> : null}
              {site.colors.length ? (
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                  Brand colours:
                  {site.colors.slice(0, 5).map((c) => (
                    <span
                      key={c}
                      title={c}
                      className="inline-block size-4 rounded-full border border-line"
                      // A colour read from the client's own website, shown as a swatch.
                      style={{ background: c }}
                    />
                  ))}
                </p>
              ) : null}
            </div>
            {site.description && !p.offerings ? (
              <Button size="sm" variant="ghost" onClick={() => set('offerings', site.description!)}>
                Use the description
              </Button>
            ) : null}
          </div>
        ) : null}
        {PROFILE_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} help={f.help}>
            {(props) =>
              f.long ? (
                <Textarea
                  {...props}
                  rows={2}
                  value={p[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : (
                <Input {...props} value={p[f.key] ?? ''} onChange={(e) => set(f.key, e.target.value)} />
              )
            }
          </Field>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="primary"
            disabled={!p.businessName.trim()}
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: onNext })}
          >
            Continue to questions <ArrowRight className="rtl:rotate-180" />
          </Button>
          <Button
            onClick={() => save.mutate(undefined, { onSuccess: () => toast.success('Saved') })}
            disabled={!p.businessName.trim()}
          >
            Save
          </Button>
        </div>
        <p className="text-xs text-muted">
          Only the business name is required; the more you share, the better the setup fits.
        </p>
      </div>
    </Pane>
  );
}

function InterviewStep({
  session,
  onSaved,
  onNext,
}: {
  session: Session;
  onSaved: (s: Session) => void;
  onNext: () => void;
}) {
  const turns = session.interview;
  const open = turns.at(-1);
  const waiting = open && !open.done && open.answer === undefined ? open : null;
  const finished = turns.some((t) => t.done);
  const [picked, setPicked] = useState<string[]>([]);
  const [text, setText] = useState('');
  useEffect(() => {
    setPicked([]);
    setText('');
  }, [turns.length]);
  const ask = useMutation({
    mutationFn: (answer?: string) =>
      apiPost<Session>(
        `/m/assistant/setup/${session.uuid}/interview`,
        answer === undefined ? {} : { answer },
      ),
    onSuccess: onSaved,
    onError: (err) => toast.error(errorText(err)),
  });
  // The first question is asked as soon as the step opens.
  useEffect(() => {
    if (!turns.length && !ask.isPending && !ask.isError) ask.mutate(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns.length]);
  const brief = useMutation({
    mutationFn: () => apiPost<Session>(`/m/assistant/setup/${session.uuid}/brief`),
    onSuccess: (s) => {
      onSaved(s);
      onNext();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const answer = [...picked, text.trim()].filter(Boolean).join('; ');
  return (
    <Pane title="A few questions">
      <ol className="space-y-3">
        {turns
          .filter((t) => t.answer !== undefined && !t.done)
          .map((t, i) => (
            <li key={i} className="text-sm">
              <p className="font-medium">{t.question}</p>
              <p className="mt-0.5 text-muted">{t.answer || 'Skipped'}</p>
            </li>
          ))}
      </ol>
      {waiting ? (
        <div className="ai-surface anim-rise mt-4 rounded-md p-3">
          <p className="font-medium">{waiting.question}</p>
          {waiting.why ? <p className="mt-0.5 text-xs text-muted">{waiting.why}</p> : null}
          {waiting.suggestions.length ? (
            <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Suggested answers">
              {waiting.suggestions.map((s) => {
                const on = picked.includes(s);
                return (
                  <li key={s}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        waiting.multi
                          ? setPicked((x) => (on ? x.filter((y) => y !== s) : [...x, s]))
                          : ask.mutate(s)
                      }
                      className={cn('ai-chip ai-chip-next', on && 'border-primary bg-primary-soft')}
                    >
                      {on ? <Check className="size-3.5" aria-hidden /> : null}
                      {s}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <div className="mt-3 flex gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && answer) ask.mutate(answer);
              }}
              placeholder={waiting.multi ? 'Add your own, or pick from above' : 'Or answer in your own words'}
              aria-label="Your answer"
            />
            <Button
              variant="primary"
              onClick={() => ask.mutate(answer)}
              disabled={!answer}
              loading={ask.isPending}
            >
              <Send /> Answer
            </Button>
            <Button
              variant="ghost"
              onClick={() => ask.mutate('')}
              disabled={ask.isPending}
              title="Skip this question"
            >
              <SkipForward />
              <span className="sr-only">Skip</span>
            </Button>
          </div>
        </div>
      ) : ask.isPending ? (
        <p className="ai-shimmer mt-4 text-sm">Thinking of the next question…</p>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <Button
          variant={finished ? 'primary' : 'secondary'}
          onClick={() => brief.mutate()}
          loading={brief.isPending}
        >
          <Sparkles /> {finished ? 'Write the brief' : "That's enough, write the brief"}
        </Button>
        {finished ? <p className="text-sm text-muted">The assistant has what it needs.</p> : null}
      </div>
    </Pane>
  );
}

/** A list of short texts, edited as removable chips with an add box. */
function ChipList({
  label,
  values,
  onChange,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft('');
  };
  return (
    <Field label={label}>
      {(f) => (
        <div>
          {values.length ? (
            <ul className="mb-1.5 flex flex-wrap gap-1.5">
              {values.map((v) => (
                <li key={v}>
                  <Badge tone="outline">
                    {v}
                    <button
                      type="button"
                      aria-label={`Remove ${v}`}
                      onClick={() => onChange(values.filter((x) => x !== v))}
                    >
                      ×
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <Input
              {...f}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder="Add and press Enter"
            />
            <Button
              type="button"
              variant="ghost"
              onClick={add}
              disabled={!draft.trim()}
              aria-label={`Add to ${label}`}
            >
              <Plus />
            </Button>
          </div>
        </div>
      )}
    </Field>
  );
}

const FIELD_TYPES = [
  'text',
  'textarea',
  'number',
  'decimal',
  'currency',
  'date',
  'boolean',
  'select',
  'multi_select',
  'url',
  'email',
  'phone',
];
const ENTITIES: Entity[] = ['contact', 'organization', 'deal', 'lead'];

function BriefStep({
  session,
  onSaved,
  onNext,
}: {
  session: Session;
  onSaved: (s: Session) => void;
  onNext: () => void;
}) {
  const { labels } = useBoot();
  const [b, setB] = useState<Brief | null>(session.brief);
  useEffect(() => setB(session.brief), [session.brief]);
  const save = useMutation({
    mutationFn: (approve: boolean) =>
      apiPut<Session>(`/m/assistant/setup/${session.uuid}/brief`, { brief: b, approve }),
    onSuccess: (s, approve) => {
      onSaved(s);
      if (approve) onNext();
      else toast.success('Saved');
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const rewrite = useMutation({
    mutationFn: () => apiPost<Session>(`/m/assistant/setup/${session.uuid}/brief`),
    onSuccess: onSaved,
    onError: (err) => toast.error(errorText(err)),
  });
  if (!b)
    return (
      <Pane>
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>No brief yet.</p>
          <Button variant="primary" onClick={() => rewrite.mutate()} loading={rewrite.isPending}>
            <Sparkles /> Write the brief
          </Button>
        </div>
      </Pane>
    );
  const set = <K extends keyof Brief>(k: K, v: Brief[K]) => setB({ ...b, [k]: v });
  const plural = (e: Entity) => labels[e]?.plural ?? e;
  return (
    <div className="flex flex-col gap-4">
      <Pane title="Your business, as the assistant understood it">
        <p className="mb-3 text-sm text-muted">
          Correct anything that is wrong or missing. The setup is built from this.
        </p>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Business name">
              {(f) => (
                <Input {...f} value={b.businessName} onChange={(e) => set('businessName', e.target.value)} />
              )}
            </Field>
            <Field label="Industry">
              {(f) => <Input {...f} value={b.industry} onChange={(e) => set('industry', e.target.value)} />}
            </Field>
          </div>
          <Field label="Summary">
            {(f) => (
              <Textarea {...f} rows={3} value={b.summary} onChange={(e) => set('summary', e.target.value)} />
            )}
          </Field>
          <ChipList label="What you offer" values={b.offerings} onChange={(v) => set('offerings', v)} />
          <ChipList
            label="Customer types"
            values={b.customerTypes}
            onChange={(v) => set('customerTypes', v)}
          />
          <ChipList label="How customers find you" values={b.channels} onChange={(v) => set('channels', v)} />
          <ChipList label="Problems to solve" values={b.problems} onChange={(v) => set('problems', v)} />
        </div>
      </Pane>

      <Pane title="Your process">
        <ol className="space-y-2">
          {b.stages.map((st, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="tabular w-6 text-end text-sm text-muted">{i + 1}.</span>
              <Input
                value={st.name}
                aria-label={`Stage ${i + 1}`}
                onChange={(e) =>
                  set(
                    'stages',
                    b.stages.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  )
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove stage ${st.name}`}
                onClick={() =>
                  set(
                    'stages',
                    b.stages.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ol>
        <Button
          className="mt-2"
          size="sm"
          variant="ghost"
          onClick={() => set('stages', [...b.stages, { name: '' }])}
        >
          <Plus /> Add a stage
        </Button>
      </Pane>

      <Pane title="What you need to record">
        <ul className="space-y-2">
          {b.track.map((t, i) => (
            <li
              key={i}
              className="grid grid-cols-[1fr_1fr_auto] items-center gap-2 sm:grid-cols-[10rem_1fr_9rem_auto]"
            >
              <NativeSelect
                aria-label="Record type"
                value={t.entity}
                onChange={(e) =>
                  set(
                    'track',
                    b.track.map((x, j) => (j === i ? { ...x, entity: e.target.value as Entity } : x)),
                  )
                }
              >
                {ENTITIES.map((e) => (
                  <option key={e} value={e}>
                    {plural(e)}
                  </option>
                ))}
              </NativeSelect>
              <Input
                aria-label="Field name"
                value={t.label}
                onChange={(e) =>
                  set(
                    'track',
                    b.track.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)),
                  )
                }
              />
              <NativeSelect
                aria-label="Kind of value"
                className="hidden sm:block"
                value={t.type}
                onChange={(e) =>
                  set(
                    'track',
                    b.track.map((x, j) => (j === i ? { ...x, type: e.target.value } : x)),
                  )
                }
              >
                {FIELD_TYPES.map((ft) => (
                  <option key={ft} value={ft}>
                    {ft.replace('_', ' ')}
                  </option>
                ))}
              </NativeSelect>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${t.label}`}
                onClick={() =>
                  set(
                    'track',
                    b.track.filter((_, j) => j !== i),
                  )
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          className="mt-2"
          size="sm"
          variant="ghost"
          onClick={() => set('track', [...b.track, { entity: 'contact', label: '', type: 'text' }])}
        >
          <Plus /> Add a field
        </Button>
      </Pane>

      <Pane title="Team and words">
        <div className="grid gap-4">
          <ul className="space-y-2">
            {b.roles.map((r, i) => (
              <li key={i} className="grid grid-cols-[1fr_2fr_auto] items-center gap-2">
                <Input
                  aria-label="Role"
                  value={r.name}
                  onChange={(e) =>
                    set(
                      'roles',
                      b.roles.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                />
                <Input
                  aria-label="What they do"
                  value={r.does ?? ''}
                  placeholder="What they do"
                  onChange={(e) =>
                    set(
                      'roles',
                      b.roles.map((x, j) => (j === i ? { ...x, does: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${r.name}`}
                  onClick={() =>
                    set(
                      'roles',
                      b.roles.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
          <Button
            size="sm"
            variant="ghost"
            className="w-fit"
            onClick={() => set('roles', [...b.roles, { name: '' }])}
          >
            <Plus /> Add a role
          </Button>
          <div>
            <p className="mb-1.5 text-sm font-medium">What you call your records</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {ENTITIES.map((e) => (
                <WordPair
                  key={e}
                  label={labels[e]?.plural ?? e}
                  value={b.vocabulary[e]}
                  onChange={(v) => set('vocabulary', { ...b.vocabulary, [e]: v })}
                />
              ))}
            </div>
          </div>
          <ChipList label="Reports you want" values={b.reports} onChange={(v) => set('reports', v)} />
          <ChipList
            label="Routines to automate"
            values={b.automations}
            onChange={(v) => set('automations', v)}
          />
        </div>
      </Pane>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          onClick={() => save.mutate(true)}
          loading={save.isPending}
          disabled={!b.businessName.trim()}
        >
          <Check /> Approve the brief
        </Button>
        <Button onClick={() => save.mutate(false)} disabled={save.isPending}>
          Save
        </Button>
        <Button variant="ghost" onClick={() => rewrite.mutate()} loading={rewrite.isPending}>
          <RefreshCw /> Write it again
        </Button>
      </div>
    </div>
  );
}

function WordPair({
  label,
  value,
  onChange,
}: {
  label: ReactNode;
  value: { singular: string; plural: string } | undefined;
  onChange: (v: { singular: string; plural: string } | undefined) => void;
}) {
  const v = value ?? { singular: '', plural: '' };
  const change = (k: 'singular' | 'plural', s: string) => {
    const next = { ...v, [k]: s };
    onChange(next.singular || next.plural ? next : undefined);
  };
  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="w-28 shrink-0 text-muted">{label}</span>
      <Input
        aria-label={`One, instead of ${String(label)}`}
        placeholder="One"
        value={v.singular}
        onChange={(e) => change('singular', e.target.value)}
      />
      <Input
        aria-label={`Many, instead of ${String(label)}`}
        placeholder="Many"
        value={v.plural}
        onChange={(e) => change('plural', e.target.value)}
      />
    </div>
  );
}

const AREA_ICON: Record<string, typeof Sparkles> = {
  branding: Palette,
  preset: Layers,
  names: Tags,
  pipeline: Workflow,
  fields: ListChecks,
  roles: Users,
  reports: BarChart3,
  next: Lightbulb,
};

function ProposalStep({
  session,
  onSaved,
  onNext,
}: {
  session: Session;
  onSaved: (s: Session) => void;
  onNext: () => void;
}) {
  const { labels } = useBoot();
  const items = session.proposal?.items ?? [];
  const [off, setOff] = useState<string[]>([]);
  const [texts, setTexts] = useState<Record<string, Record<string, string | boolean>>>({});
  const [dropped, setDropped] = useState<Record<string, Record<string, number[]>>>({});
  const propose = useMutation({
    mutationFn: () => apiPost<Session>(`/m/assistant/setup/${session.uuid}/proposal`),
    onSuccess: onSaved,
    onError: (err) => toast.error(errorText(err)),
  });
  // The proposal is made as soon as the step opens.
  useEffect(() => {
    if (!session.proposal && !propose.isPending && !propose.isError) propose.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.proposal]);
  const edits = (it: ProposalItem): ChangeEdits => {
    const set = it.preview.fields.flatMap((f): NonNullable<ChangeEdits['set']> => {
      const v = f.edit ? texts[it.id]?.[pathKey(f.edit)] : undefined;
      if (!f.edit || v === undefined) return [];
      if (typeof v === 'boolean') return v !== (f.value === 'Yes') ? [{ path: f.edit, value: v }] : [];
      return v.trim() && v !== f.value ? [{ path: f.edit, value: v.trim() }] : [];
    });
    const drop = (it.preview.lists ?? []).flatMap((l) =>
      (dropped[it.id]?.[pathKey(l.path)] ?? []).map((index) => ({ path: l.path, index })),
    );
    return { ...(set.length ? { set } : {}), ...(drop.length ? { drop } : {}) };
  };
  const chosen = items.filter((i) => !i.advice && !off.includes(i.id));
  const build = useMutation({
    mutationFn: () =>
      apiPost<Session>(`/m/assistant/setup/${session.uuid}/build`, {
        include: chosen.map((i) => i.id),
        edits: Object.fromEntries(chosen.map((i) => [i.id, edits(i)])),
      }),
    onSuccess: (s) => {
      onSaved(s);
      onNext();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  if (propose.isPending || (!session.proposal && !propose.isError))
    return (
      <Pane>
        <p className="ai-shimmer text-sm">Putting your setup together…</p>
      </Pane>
    );
  if (!items.length)
    return (
      <Pane>
        <div className="flex flex-col items-start gap-2 text-sm">
          <p>The setup could not be prepared.</p>
          <Button onClick={() => propose.mutate()}>
            <RefreshCw /> Try again
          </Button>
        </div>
      </Pane>
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted">
        Here is the setup for {session.brief?.businessName}. Untick anything you do not want, rename things
        and leave out items in lists. Nothing is built until you choose <strong>Build my CRM</strong>, and
        nothing you already have is removed.
      </p>
      {items.map((it) => {
        const Icon = AREA_ICON[it.area] ?? Sparkles;
        const on = !off.includes(it.id);
        return (
          <Pane key={it.id} padded={false}>
            <div className={cn('p-4', !on && 'opacity-60')}>
              <div className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary">
                  <Icon className="size-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{it.title}</p>
                  {it.detail ? <p className="text-sm text-muted">{it.detail}</p> : null}
                </div>
                {it.advice ? (
                  <Badge tone="outline">Suggestion</Badge>
                ) : (
                  <label className="flex shrink-0 items-center gap-1.5 text-sm">
                    <Checkbox
                      checked={on}
                      onCheckedChange={(v) =>
                        setOff((x) => (v ? x.filter((y) => y !== it.id) : [...x, it.id]))
                      }
                    />
                    Include
                  </label>
                )}
              </div>
              {on ? (
                <div className="ps-11">
                  {it.area === 'branding' && typeof it.payload.primary === 'string' ? (
                    <p className="mt-2 flex items-center gap-2 text-xs text-muted">
                      Colours:
                      {[it.payload.primary, it.payload.accent]
                        .filter((c): c is string => typeof c === 'string')
                        .map((c) => (
                          // A colour from the client's own website, shown as a swatch.
                          <span
                            key={c}
                            className="inline-block size-5 rounded-full border border-line"
                            style={{ background: c }}
                          />
                        ))}
                    </p>
                  ) : null}
                  <ChangePreview
                    preview={it.preview}
                    input={it.payload}
                    labels={labels}
                    recordPath={() => null}
                    texts={texts[it.id] ?? {}}
                    onText={(k, v) => setTexts((x) => ({ ...x, [it.id]: { ...x[it.id], [k]: v } }))}
                    dropped={dropped[it.id] ?? {}}
                    onToggle={(k, index, keep) =>
                      setDropped((x) => {
                        const list = x[it.id]?.[k] ?? [];
                        return {
                          ...x,
                          [it.id]: {
                            ...x[it.id],
                            [k]: keep ? list.filter((i) => i !== index) : [...list, index],
                          },
                        };
                      })
                    }
                    hideDetails
                  />
                </div>
              ) : null}
            </div>
          </Pane>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={() => build.mutate()}
          loading={build.isPending}
          disabled={!chosen.length}
        >
          <Hammer /> Build my CRM
        </Button>
        <Button variant="ghost" onClick={() => propose.mutate()} disabled={build.isPending}>
          <RefreshCw /> Propose again
        </Button>
        <span className="text-sm text-muted">{chosen.length} parts chosen</span>
      </div>
    </div>
  );
}

function BuiltStep({ session }: { session: Session }) {
  const results = session.built?.results ?? [];
  const failed = results.filter((r) => !r.ok);
  return (
    <Pane title={failed.length ? 'Built, with a few things to check' : 'Your CRM is set up'}>
      <ul className="space-y-1.5 text-sm">
        {results.map((r, i) => (
          <li key={i} className="flex items-start gap-2">
            {r.ok ? (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" aria-label="Done" />
            ) : (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-accent" aria-label="Not done" />
            )}
            <span>{r.message}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
        <Button asChild variant="primary">
          <Link to="/deals">See your pipeline</Link>
        </Button>
        <Button asChild>
          <Link to="/settings/fields">Review fields</Link>
        </Button>
        <Button asChild variant="ghost">
          <Link to="/m/assistant">Ask the assistant for the next steps</Link>
        </Button>
      </div>
    </Pane>
  );
}
