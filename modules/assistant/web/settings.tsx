import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, ExternalLink, KeyRound, RefreshCw, Sparkles, Star, Wand2 } from 'lucide-react';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api';
import { useBoot } from '@/app/session';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/button';
import { Field, Input, NativeSelect, Textarea } from '@/components/ui/input';
import { Checkbox, Switch } from '@/components/ui/checkbox';
import { Badge, ErrorState, Pane, Skeleton } from '@/components/ui/misc';

export interface Config {
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
  preset: string | null;
  setupEnabled: boolean;
  complianceProfile?: string;
}

interface Provider {
  id: string;
  name: string;
  format: 'messages' | 'chat_completions';
  baseUrl: string;
  keyUrl: string | null;
  keyPrefix: string | null;
  tier: 'free' | 'free_tier' | 'paid';
  note: string;
  recommended: string[];
}

interface Model {
  id: string;
  recommended: boolean;
  best: boolean;
}

type Test = { state: 'idle' | 'running' } | { state: 'ok'; ms: number } | { state: 'error'; message: string };

const CUSTOM = 'custom';
const key = ['m', 'assistant'] as const;
const errorText = (err: unknown) =>
  err instanceof ApiError ? err.message : 'Something went wrong. Try again.';
const TIER: Record<Provider['tier'], string> = { free: 'Free models', free_tier: 'Free tier', paid: 'Paid' };

/** Suggested limits: generous for a small team, and they stop a runaway month. */
const SUGGESTED = { monthly: 2_000_000, daily: 200_000 };

export function SettingsPanel() {
  const qc = useQueryClient();
  const { labels, access } = useBoot();
  const config = useQuery({
    queryKey: [...key, 'config'],
    queryFn: () => apiGet<Config>('/m/assistant/config'),
  });
  const providers = useQuery({
    queryKey: [...key, 'providers'],
    queryFn: () => apiGet<{ data: Provider[] }>('/m/assistant/providers').then((r) => r.data),
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
  const [choice, setChoice] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState('');
  const [onlyFree, setOnlyFree] = useState(false);
  const [test, setTest] = useState<Test>({ state: 'idle' });
  useEffect(() => {
    if (!config.data) return;
    setDraft(config.data);
    setChoice(config.data.preset ?? (config.data.provider ? CUSTOM : null));
  }, [config.data]);

  const saved = config.data;
  const preset = providers.data?.find((p) => p.id === choice);
  // The saved key only counts for the provider it was saved for.
  const keySaved =
    !!saved?.hasApiKey &&
    choice === (saved.preset ?? (saved.provider ? CUSTOM : null)) &&
    (choice !== CUSTOM || draft?.baseUrl === saved.baseUrl);

  const models = useMutation({
    mutationFn: () =>
      apiPost<{ data: Model[] }>('/m/assistant/models', {
        ...(preset ? { preset: preset.id } : { provider: draft?.provider, baseUrl: draft?.baseUrl || null }),
        ...(apiKey ? { apiKey } : {}),
      }).then((r) => r.data),
    onSuccess: (list) => {
      // Pick the best model when none is chosen yet, or the chosen one is not offered.
      const best = list.find((m) => m.best) ?? list[0];
      if (best && draft && (!draft.model || !list.some((m) => m.id === draft.model)))
        setDraft({ ...draft, model: best.id });
    },
  });
  // A saved provider: load its models straight away.
  useEffect(() => {
    if (keySaved && choice && choice !== CUSTOM && !models.data && !models.isPending) models.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySaved, choice]);

  const save = useMutation({
    mutationFn: async () => {
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
      await apiPatch<Config>('/m/assistant/config', {
        name: d.name,
        ...(preset
          ? { preset: preset.id }
          : {
              preset: null,
              provider: d.provider,
              baseUrl: d.baseUrl || null,
              ...(extra ? { headers: extra } : {}),
            }),
        model: d.model || null,
        monthlyTokenCap: d.monthlyTokenCap,
        userDailyTokenCap: d.userDailyTokenCap,
        retentionDays: d.retentionDays,
        excludedEntities: d.excludedEntities,
        hipaaAcknowledged: d.hipaaAcknowledged,
        ...(apiKey ? { apiKey } : {}),
      });
    },
    onSuccess: () => {
      setApiKey('');
      setHeaders('');
      void qc.invalidateQueries({ queryKey: key });
    },
  });
  const runTest = async () => {
    setTest({ state: 'running' });
    try {
      await save.mutateAsync();
      const r = await apiPost<{ ok: boolean; ms: number }>('/m/assistant/test');
      setTest({ state: 'ok', ms: r.ms });
      toast.success('Connected');
    } catch (err) {
      setTest({ state: 'error', message: errorText(err) });
    }
  };
  const toggleSetup = useMutation({
    mutationFn: (on: boolean) => apiPatch<Config>('/m/assistant/config', { setupEnabled: on }),
    onSuccess: (c) => {
      toast.success(c.setupEnabled ? 'Workspace setup turned on' : 'Workspace setup turned off');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const tips = useMemo(() => {
    if (!draft) return [];
    const out: { text: string; apply: () => void }[] = [];
    const best = models.data?.find((m) => m.best);
    if (best && draft.model && draft.model !== best.id)
      out.push({
        text: `Use ${best.id}, the recommended model for this provider`,
        apply: () => setDraft({ ...draft, model: best.id }),
      });
    if (!draft.monthlyTokenCap)
      out.push({
        text: `Set a monthly limit of ${SUGGESTED.monthly.toLocaleString()} tokens so costs cannot run away`,
        apply: () => setDraft({ ...draft, monthlyTokenCap: SUGGESTED.monthly }),
      });
    if (!draft.userDailyTokenCap)
      out.push({
        text: `Limit each person to ${SUGGESTED.daily.toLocaleString()} tokens a day`,
        apply: () => setDraft({ ...draft, userDailyTokenCap: SUGGESTED.daily }),
      });
    if (draft.retentionDays > 90)
      out.push({
        text: 'Keep conversations for 30 days; older ones are rarely useful',
        apply: () => setDraft({ ...draft, retentionDays: 30 }),
      });
    return out;
  }, [draft, models.data]);

  if (config.isError) return <ErrorState error={config.error} onRetry={() => void config.refetch()} />;
  if (config.isPending || !draft || providers.isPending) return <Skeleton className="h-96" />;
  const set = (patch: Partial<Config>) => setDraft({ ...draft, ...patch });
  const choose = (id: string) => {
    if (id === choice) return;
    setChoice(id);
    setTest({ state: 'idle' });
    models.reset();
    // Start from the provider's best model; fetching the list can refine it.
    const next = providers.data?.find((p) => p.id === id);
    set({ model: next?.recommended.find((m) => !m.startsWith(':')) ?? null });
  };
  const shown = (providers.data ?? []).filter((p) => !onlyFree || p.tier !== 'paid');
  const keyLooksWrong =
    !!apiKey && !!preset?.keyPrefix && apiKey.length > 6 && !apiKey.startsWith(preset.keyPrefix);
  const steps = [
    { label: 'Provider', done: !!choice && (choice !== CUSTOM || (!!draft.provider && !!draft.baseUrl)) },
    { label: 'API key', done: keySaved || !!apiKey },
    { label: 'Model', done: !!draft.model },
    { label: 'Connected', done: test.state === 'ok' },
  ];
  const entities = ['contact', 'organization', 'lead', 'deal', 'activity'];

  return (
    <div className="flex flex-col gap-4">
      <section className="ai-surface rounded-lg p-4 shadow-raised" aria-labelledby="connect-title">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="ai-mark flex size-9 items-center justify-center rounded-lg" aria-hidden>
              <Sparkles className="size-5" />
            </span>
            <div>
              <h2 id="connect-title" className="font-semibold">
                Connect an AI provider
              </h2>
              <p className="text-sm text-muted">Pick a provider, paste its API key, and you are set.</p>
            </div>
          </div>
          <ol className="flex flex-wrap items-center gap-2 text-xs" aria-label="Progress">
            {steps.map((s, i) => (
              <li key={s.label} className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full border text-[11px] transition-colors duration-150',
                    s.done ? 'anim-pop border-primary bg-primary text-primary-fg' : 'border-line text-muted',
                  )}
                  aria-hidden
                >
                  {s.done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={s.done ? 'text-ink' : 'text-muted'}>
                  {s.label}
                  <span className="sr-only">{s.done ? ' (done)' : ''}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">1. Provider</h3>
          <label className="flex items-center gap-2 text-xs text-muted">
            <Switch
              checked={onlyFree}
              onCheckedChange={setOnlyFree}
              aria-label="Only providers with free use"
            />
            Free to start
          </label>
        </div>
        <div role="radiogroup" aria-label="AI provider" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[...shown.map((p) => ({ ...p, custom: false })), null].map((p) => {
            const id = p ? p.id : CUSTOM;
            const active = choice === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => choose(id)}
                className={cn(
                  'flex items-start gap-3 rounded-md border bg-surface p-3 text-start transition-[border-color,box-shadow,transform] duration-150 ease-out active:scale-[0.99]',
                  active
                    ? 'border-primary shadow-raised ring-2 ring-primary-soft'
                    : 'border-line hover:border-line-strong',
                )}
              >
                <span
                  className={cn(
                    'flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold transition-colors duration-150',
                    active ? 'ai-mark' : 'bg-primary-soft text-primary',
                  )}
                  aria-hidden
                >
                  {p ? p.name.charAt(0).toUpperCase() : <Wand2 className="size-4" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{p ? p.name : 'Other compatible API'}</span>
                    {p ? (
                      <Badge tone={p.tier === 'paid' ? 'outline' : 'primary'}>{TIER[p.tier]}</Badge>
                    ) : null}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted">
                    {p ? p.note : 'Any service with a compatible API, including your own.'}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {choice === CUSTOM ? (
          <div className="anim-rise mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="API format">
              {(p) => (
                <NativeSelect
                  {...p}
                  value={draft.provider ?? ''}
                  onChange={(e) => set({ provider: (e.target.value || null) as Config['provider'] })}
                >
                  <option value="">Choose</option>
                  <option value="chat_completions">Chat completions (most common)</option>
                  <option value="messages">Messages</option>
                </NativeSelect>
              )}
            </Field>
            <Field
              label="Base URL"
              help="Chat completions: up to and including /v1. Messages: the host only."
            >
              {(p) => (
                <Input
                  {...p}
                  value={draft.baseUrl ?? ''}
                  onChange={(e) => set({ baseUrl: e.target.value })}
                />
              )}
            </Field>
            <Field
              label="Extra request headers"
              help={
                draft.headerNames.length
                  ? `Saved: ${draft.headerNames.join(', ')}. One "Name: value" per line replaces them.`
                  : 'Optional. One "Name: value" per line.'
              }
            >
              {(p) => (
                <Textarea {...p} rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} />
              )}
            </Field>
          </div>
        ) : null}

        {choice ? (
          <div className="anim-rise mt-5 grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-medium">
                <KeyRound className="size-4 text-muted" aria-hidden /> 2. API key
              </h3>
              <Field
                label="API key"
                help={
                  keySaved
                    ? 'A key is saved and encrypted. Paste a new one to replace it.'
                    : 'Stored encrypted. It is only ever sent to this provider.'
                }
              >
                {(p) => (
                  <Input
                    {...p}
                    type="password"
                    autoComplete="off"
                    placeholder={keySaved ? '••••••••••••' : preset?.keyPrefix ? `${preset.keyPrefix}…` : ''}
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value.trim())}
                    onBlur={() => apiKey.length > 8 && models.mutate()}
                  />
                )}
              </Field>
              {keyLooksWrong ? (
                <p className="mt-1 text-xs text-muted">
                  Keys for {preset!.name} usually start with “{preset!.keyPrefix}”. Check you copied the whole
                  key.
                </p>
              ) : null}
              {preset?.keyUrl ? (
                <a
                  href={preset.keyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-sm text-primary hover:underline"
                >
                  Get a {preset.name} key <ExternalLink className="size-3.5" aria-hidden />
                </a>
              ) : null}
            </div>

            <div>
              <div className="mb-2 flex items-center justify-between gap-2">
                <h3 className="text-sm font-medium">3. Model</h3>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => models.mutate()}
                  loading={models.isPending}
                  disabled={!keySaved && !apiKey}
                >
                  <RefreshCw /> {models.data ? 'Refresh' : 'Fetch models'}
                </Button>
              </div>
              {models.isPending ? (
                <p className="ai-shimmer text-sm" aria-live="polite">
                  Asking {preset?.name ?? 'the provider'} which models you can use…
                </p>
              ) : models.isError ? (
                <p className="text-sm text-muted" role="alert">
                  {errorText(models.error)} You can still type a model name.
                </p>
              ) : null}
              <ModelPicker
                live={!!models.data}
                models={
                  models.data ??
                  (preset?.recommended ?? [])
                    .filter((m) => !m.startsWith(':'))
                    .map((id, i) => ({ id, recommended: true, best: i === 0 }))
                }
                value={draft.model ?? ''}
                onChange={(model) => set({ model })}
              />
            </div>
          </div>
        ) : null}

        {choice ? (
          <div className="mt-5 flex flex-wrap items-center gap-3 border-t border-line pt-4">
            <Button
              variant="primary"
              onClick={() => void runTest()}
              loading={test.state === 'running'}
              disabled={!steps[0]!.done || !steps[1]!.done || !steps[2]!.done}
            >
              <Sparkles /> Save and test
            </Button>
            <span aria-live="polite" className="text-sm">
              {test.state === 'running' ? (
                <span className="inline-flex items-center gap-2">
                  <span className="ai-dots inline-flex gap-1" aria-hidden>
                    <span />
                    <span />
                    <span />
                  </span>
                  <span className="ai-shimmer">Connecting</span>
                </span>
              ) : test.state === 'ok' ? (
                <span className="anim-pop inline-flex items-center gap-1.5 text-ink">
                  <Check className="size-4 text-primary" aria-hidden /> Connected in{' '}
                  {(test.ms / 1000).toFixed(1)} s. The assistant is ready.
                </span>
              ) : test.state === 'error' ? (
                <span className="text-ink" role="alert">
                  {test.message}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </section>

      {tips.length ? (
        <Pane title="Recommended for best results">
          <ul className="divide-y divide-line">
            {tips.map((t) => (
              <li key={t.text} className="anim-rise flex items-center justify-between gap-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Star className="size-4 shrink-0 text-primary" aria-hidden /> {t.text}
                </span>
                <Button size="sm" onClick={t.apply}>
                  Apply
                </Button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Applied tips take effect when you save.</p>
        </Pane>
      ) : null}

      {access.isAdmin ? (
        <Pane title="Workspace setup">
          <div className="flex items-start justify-between gap-4">
            <div className="text-sm">
              <p>
                Let the assistant set up this workspace for your business: names, fields, pipelines, roles,
                modules and industry presets. Only admins can use it, and every change is shown for you to
                confirm first. Nothing you set up yourself is overwritten.
              </p>
              <p className="mt-1 text-muted">
                Off by default. Turn it off again once your workspace is set up.
              </p>
            </div>
            <Switch
              checked={saved?.setupEnabled ?? false}
              onCheckedChange={(on) => toggleSetup.mutate(on)}
              disabled={toggleSetup.isPending}
              aria-label="Let the assistant set up the workspace"
            />
          </div>
        </Pane>
      ) : null}

      <Pane title="Name, limits and data">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Assistant name" help="What everyone sees, instead of the provider's name.">
            {(p) => <Input {...p} value={draft.name} onChange={(e) => set({ name: e.target.value })} />}
          </Field>
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
        {entities.length && entities.every((e) => draft.excludedEntities.includes(e)) ? (
          <p className="mt-2 text-sm font-medium text-ink" role="status">
            Every record type is ticked, so the assistant cannot look anything up. Untick the ones it may
            read.
          </p>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Only fields each person can see are sent, and sensitive values stay masked. Changes the assistant
          proposes run only after the person confirms them, and are recorded in the audit log.
        </p>
        {saved?.complianceProfile === 'hipaa' ? (
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
          <Button
            variant="primary"
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: () => toast.success('Saved'),
                onError: (err) => toast.error(errorText(err)),
              })
            }
            loading={save.isPending && test.state !== 'running'}
          >
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

/** Recommended models as one-click choices, then every model in a list; any name can be typed. */
function ModelPicker({
  models,
  live,
  value,
  onChange,
}: {
  models: Model[];
  /** The list came from the provider (not just our suggestions). */
  live: boolean;
  value: string;
  onChange: (model: string) => void;
}) {
  const recommended = models.filter((m) => m.recommended).slice(0, 4);
  return (
    <div className="flex flex-col gap-2">
      {recommended.length ? (
        <div role="radiogroup" aria-label="Recommended models" className="flex flex-wrap gap-1.5">
          {recommended.map((m) => (
            <button
              key={m.id}
              type="button"
              role="radio"
              aria-checked={value === m.id}
              onClick={() => onChange(m.id)}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors duration-150 active:scale-[0.98]',
                value === m.id
                  ? 'border-primary bg-primary text-primary-fg'
                  : 'border-line bg-surface hover:border-line-strong',
              )}
            >
              {m.best ? <Star className="size-3" aria-hidden /> : null}
              {m.id}
              {m.best ? <span className="sr-only"> (recommended)</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <Field
        label="Model"
        help={
          live
            ? `${models.length} available with your key. Pick one or type its name.`
            : 'Suggested models. Add your key to see every model you can use.'
        }
      >
        {(p) => (
          <>
            <Input
              {...p}
              list="assistant-models"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="Model name"
            />
            <datalist id="assistant-models">
              {models.map((m) => (
                <option key={m.id} value={m.id} />
              ))}
            </datalist>
          </>
        )}
      </Field>
    </div>
  );
}
