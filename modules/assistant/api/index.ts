import { z } from 'zod';
import {
  AppError,
  allowsTestingAids,
  audit,
  escapeLike,
  callTool,
  db,
  decrypt,
  defineRoutes,
  effectiveCompliance,
  encrypt,
  every,
  getBranding,
  inputJsonSchema,
  isModuleEnabled,
  logger,
  newUuid,
  notFound,
  toolDefs,
  type ApiModule,
  type AuthUser,
  type PrivacyHandler,
  type RequestContext,
  type ToolDef,
  type Knex,
} from '@app/api/module-api';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response } from 'express';
import * as m0001 from './migrations/0001_assistant';
import * as m0002 from './migrations/0002_presets';
import * as m0003 from './migrations/0003_vision';
import {
  assertSafeModelUrl,
  chat,
  modelHosts,
  chatStream,
  listModels,
  WIRE_FORMATS,
  IMAGE_TYPES,
  type Block,
  type ImageType,
  type ChatMessage,
  type ProviderConfig,
} from './providers';
import { compatibleServers, findPreset, providerPresets, rankModels, readsImages } from './catalog';
import { linkRecords, recordsIn, type RecordRef } from './links';
import { CONFIG_PROMPT, CONFIG_TOOLS, describeChange, precheckConfigChange } from './config-tools';
import { SETUP_PROMPT, SETUP_TOOLS } from './setup-tools';

const CONFIG = 'm_assistant_config';
const CONVERSATIONS = 'm_assistant_conversations';
const MESSAGES = 'm_assistant_messages';
const USAGE = 'm_assistant_usage';
const KEY_AAD = 'm_assistant_config.api_key_enc';

/** Model calls per message before the assistant must answer (stops runaway tool loops). */
const MAX_STEPS = 8;
/** Characters of one tool result sent back to the model. */
const MAX_RESULT = 20_000;

interface ConfigRow {
  id: number;
  name: string;
  provider: string | null;
  base_url: string | null;
  model: string | null;
  api_key_enc: string | null;
  headers: Record<string, string> | string;
  monthly_token_cap: number;
  user_daily_token_cap: number;
  retention_days: number;
  excluded_entities: string[] | string;
  hipaa_acknowledged: number | boolean;
  preset: string | null;
  setup_enabled: number | boolean;
  vision: number | boolean | null;
}

/** Whether the model reads images: the admin's choice, else the provider list (simulated: yes). */
function visionAuto(row: ConfigRow) {
  if (row.provider === 'simulated') return true;
  return readsImages(findPreset(row.preset), row.model);
}
const readsImagesNow = (row: ConfigRow) => (row.vision === null ? visionAuto(row) : !!row.vision);

const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

async function loadConfig(): Promise<ConfigRow> {
  const row = (await db(CONFIG).orderBy('id').first()) as ConfigRow | undefined;
  if (row) return row;
  await db(CONFIG).insert({ headers: '{}', excluded_entities: '[]' });
  return (await db(CONFIG).orderBy('id').first()) as ConfigRow;
}

/** Usable when an admin set provider, model and key, and (under hipaa) acknowledged the risk. */
async function providerConfig(row: ConfigRow): Promise<ProviderConfig | null> {
  if (row.provider === 'simulated')
    return allowsTestingAids()
      ? { provider: 'simulated', baseUrl: '', model: SIMULATED.recommended[0]!, apiKey: '', headers: {} }
      : null;
  if (!row.provider || !row.base_url || !row.model) return null;
  // Listed providers always need a key; a compatible server of your own may not (a local model).
  if (!row.api_key_enc && row.preset) return null;
  const { profile } = await effectiveCompliance();
  if (profile === 'hipaa' && !row.hipaa_acknowledged) return null;
  return {
    provider: row.provider as ProviderConfig['provider'],
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key_enc ? decrypt(row.api_key_enc, KEY_AAD) : '',
    headers: json<Record<string, string>>(row.headers),
  };
}

/**
 * Scripted replies for trying the assistant out without AI or tokens (`simulated.ts`). Listed first,
 * and only where testing aids are allowed: development, tests and demo instances.
 */
const SIMULATED = {
  id: 'simulated',
  name: 'Simulated replies (testing)',
  format: 'simulated',
  baseUrl: '',
  keyUrl: null,
  keyPrefix: null,
  tier: 'free',
  note: 'No AI, no API key and no tokens: scripted answers that still look up your records and propose changes to confirm.',
  recommended: ['scripted'],
} as const;

const presets = () => [
  ...(allowsTestingAids() ? [SIMULATED] : []),
  ...providerPresets().map((p) => ({
    id: p.id,
    name: p.name,
    format: p.format,
    baseUrl: p.baseUrl,
    keyUrl: p.keyUrl ?? null,
    keyPrefix: p.keyPrefix ?? null,
    tier: p.tier,
    note: p.note,
    recommended: p.recommended,
  })),
];

const configDto = (row: ConfigRow) => ({
  name: row.name,
  provider: row.provider,
  baseUrl: row.base_url,
  model: row.model,
  hasApiKey: !!row.api_key_enc,
  headerNames: Object.keys(json<Record<string, string>>(row.headers)),
  monthlyTokenCap: row.monthly_token_cap,
  userDailyTokenCap: row.user_daily_token_cap,
  retentionDays: row.retention_days,
  excludedEntities: json<string[]>(row.excluded_entities),
  hipaaAcknowledged: !!row.hipaa_acknowledged,
  preset: row.preset,
  setupEnabled: !!row.setup_enabled,
  /** Null: decided from the provider list (`visionDetected`). */
  vision: row.vision === null ? null : !!row.vision,
  visionDetected: visionAuto(row),
});

/** Set by the app for every request; an admin's extra headers may not replace them. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'content-type',
  'content-length',
  'host',
  'cookie',
]);

const configSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  provider: z.enum(WIRE_FORMATS).nullish(),
  baseUrl: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullish(),
  model: z.string().trim().min(1).max(200).nullish(),
  /** Write-only: omitted keeps the stored key, null removes it. */
  apiKey: z.string().min(1).max(500).nullish(),
  /** Extra request headers some providers need (an API version, an organization). Write-only. */
  headers: z.record(z.string().regex(/^[a-zA-Z0-9-]{1,64}$/), z.string().max(500)).optional(),
  monthlyTokenCap: z.number().int().min(0).max(4_000_000_000).optional(),
  userDailyTokenCap: z.number().int().min(0).max(4_000_000_000).optional(),
  retentionDays: z.number().int().min(1).max(365).optional(),
  excludedEntities: z
    .array(z.string().regex(/^[a-z][a-z0-9_]{1,31}$/))
    .max(50)
    .optional(),
  hipaaAcknowledged: z.boolean().optional(),
  /** A provider from the list: fills in the API format, address and headers. Null: set them by hand. */
  preset: z
    .string()
    .regex(/^[a-z][a-z0-9-]{1,39}$/)
    .nullish(),
  /** Let the assistant set up the workspace for admins (off by default; admins only). */
  setupEnabled: z.boolean().optional(),
  /** Whether the model reads images; null lets the provider list decide. */
  vision: z.boolean().nullable().optional(),
});

// ---------------- Usage caps ----------------

const today = () => new Date().toISOString().slice(0, 10);

async function assertWithinCaps(cfg: ConfigRow, userId: number) {
  if (cfg.user_daily_token_cap > 0) {
    const row = await db(USAGE).where({ user_id: userId, day: today() }).first();
    if (row && Number(row.input_tokens) + Number(row.output_tokens) >= cfg.user_daily_token_cap)
      throw new AppError('QUOTA_EXCEEDED', 'You have reached your assistant limit for today.');
  }
  if (cfg.monthly_token_cap > 0) {
    const month = today().slice(0, 7);
    const total = (await db(USAGE)
      .where('day', '>=', `${month}-01`)
      .sum({ i: 'input_tokens', o: 'output_tokens' })
      .first()) as { i: number | null; o: number | null };
    if (Number(total.i ?? 0) + Number(total.o ?? 0) >= cfg.monthly_token_cap)
      throw new AppError('QUOTA_EXCEEDED', 'The assistant has reached its limit for this month.');
  }
}

async function recordUsage(userId: number, usage: { input: number; output: number }) {
  await db(USAGE)
    .insert({
      user_id: userId,
      day: today(),
      requests: 1,
      input_tokens: usage.input,
      output_tokens: usage.output,
    })
    .onConflict(['user_id', 'day'])
    .merge({
      requests: db.raw('requests + 1'),
      input_tokens: db.raw('input_tokens + ?', [usage.input]),
      output_tokens: db.raw('output_tokens + ?', [usage.output]),
    });
}

// ---------------- Conversation loop ----------------

interface Pending {
  /** Results of read tools already run in this step. */
  results: Block[];
  /** Write tools waiting for the person to confirm or decline. `id` is ours, never the model's. */
  proposals: {
    id: string;
    toolUseId: string;
    name: string;
    title: string;
    input: Record<string, unknown>;
    /** For configuration changes: what will happen, written by the server (never by the model). */
    detail?: string;
  }[];
}

async function conversationFor(uuid: string, user: AuthUser) {
  // Conversations are private to the person who started them, admins included.
  const row = await db(CONVERSATIONS).where({ uuid, user_id: user.id }).first();
  if (!row) throw notFound('Conversation');
  return row as { id: number; uuid: string; title: string; pending: Pending | string | null };
}

async function history(conversationId: number): Promise<ChatMessage[]> {
  const rows = await db(MESSAGES).where({ conversation_id: conversationId }).orderBy('id');
  return rows.map((r) => ({ role: r.role as ChatMessage['role'], content: json<Block[]>(r.content) }));
}

async function append(conversationId: number, role: ChatMessage['role'], content: Block[]) {
  await db(MESSAGES).insert({ conversation_id: conversationId, role, content: JSON.stringify(content) });
  await db(CONVERSATIONS).where({ id: conversationId }).update({ updated_at: new Date() });
}

/**
 * Every tool; excluded record types are refused per call in `runTool`. Setup tools are added only
 * for admins, once an admin has turned setup on.
 */
function toolsAllowed(cfg: ConfigRow, user: AuthUser): ToolDef[] {
  return setupAllowed(cfg, user) ? [...toolDefs(), ...SETUP_TOOLS, ...CONFIG_TOOLS] : toolDefs();
}

const setupAllowed = (cfg: ConfigRow, user: AuthUser) => !!cfg.setup_enabled && user.isAdmin;

const LINK_FIELDS: Record<string, string> = {
  contactUuid: 'contact',
  organizationUuid: 'organization',
  dealUuid: 'deal',
  leadUuid: 'lead',
};

/**
 * Every record type a tool call reads or writes, judged per tool rather than by argument shape, so
 * an excluded type cannot be reached through a link, an activity or a roll-up. Unknown tools touch
 * `*` and are refused whenever anything is excluded.
 */
function touches(name: string, input: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => typeof v === 'string' && out.push(v);
  const related = (v: unknown) => add((v as { type?: unknown } | null | undefined)?.type);
  switch (name) {
    case 'describe_schema':
    case 'search_records':
      return []; // Results are filtered by type afterwards.
    case 'setup_overview':
    case 'preview_setup':
    case 'apply_setup':
    case 'preview_preset':
    case 'add_preset':
    case 'config_overview':
    case 'config_schema':
    case 'config_read':
      return []; // Workspace configuration, never records.
    case 'config_change': {
      // An automation acts on records of its type later, as its creator.
      if (!String(input.path).startsWith('/automations')) return [];
      const body = (input.body ?? {}) as { triggerEvent?: unknown; schedule?: { entity?: unknown } | null };
      if (typeof body.triggerEvent === 'string' && body.triggerEvent.includes('.'))
        add(body.triggerEvent.split('.')[0]);
      add(body.schedule?.entity);
      // An edit without its type in the change could be any automation.
      return out.length || !String(input.path).match(/^\/automations\/./) ? out : ['*'];
    }
    case 'run_report':
    case 'change_records':
      add(input.entity);
      return out;
    case 'complete_task':
      return ['activity'];
    case 'list_records':
    case 'get_record':
      add(input.entity);
      // A deal or activity record names its linked people and organizations.
      if (input.entity === 'deal') out.push('contact', 'organization');
      if (input.entity === 'activity') out.push('contact', 'organization', 'deal', 'lead');
      return out;
    case 'get_timeline':
      // A timeline rolls up activities and changes from linked records.
      add(input.entity);
      out.push('activity', 'contact', 'organization', 'deal', 'lead');
      return out;
    case 'list_pipelines':
    case 'move_deal_stage':
      return ['deal'];
    case 'add_note':
    case 'create_task':
    case 'log_activity':
      out.push('activity');
      related(input.related);
      return out;
    case 'create_record':
    case 'update_record': {
      add(input.entity);
      const data = (input.data ?? {}) as Record<string, unknown>;
      related(data.related);
      for (const [k, t] of Object.entries(LINK_FIELDS)) if (data[k]) out.push(t);
      return out;
    }
    default:
      return ['*'];
  }
}

/** Runs a tool as the person, tagged `assistant` in the audit log; errors go back to the model. */
/** What the model should do after a tool error, so it recovers instead of guessing or looping. */
const HINTS: Record<string, string> = {
  VALIDATION_FAILED:
    'Fix the input using the details (field names and formats), then call the tool again once.',
  NOT_FOUND:
    'It does not exist or this person cannot see it. Search for it by name instead of guessing ids; do not invent one.',
  FORBIDDEN:
    'This person may not do this. Tell them plainly what is not allowed; do not try another way around it.',
  FIELD_FORBIDDEN: 'This person may not change that field. Leave it out and tell them.',
  CONFLICT:
    'It clashes with the current state (for example it already exists). Explain that; do not repeat the call.',
  MODULE_DISABLED: 'That feature is turned off in this workspace. Say an admin can turn it on.',
  QUOTA_EXCEEDED: 'A limit was reached. Tell the person; do not retry.',
};
const hintFor = (code: string) =>
  HINTS[code] ?? 'Explain the problem plainly; retry only if a change to the input would fix it.';

/** Longest text value passed to the model from one field. */
const MAX_FIELD = 2_000;

/**
 * A tool result without what costs tokens and says nothing: empty values are dropped and very
 * long text is shortened. Ids and every value present are kept.
 */
export function compact(value: unknown): unknown {
  if (typeof value === 'string')
    return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD)}… (shortened)` : value;
  if (Array.isArray(value)) return value.map(compact);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const c = compact(v);
    const empty =
      c === null ||
      c === undefined ||
      c === '' ||
      (Array.isArray(c) && !c.length) ||
      (typeof c === 'object' &&
        !Array.isArray(c) &&
        !(c instanceof Date) &&
        !Object.keys(c as object).length);
    if (!empty) out[k] = c;
  }
  return out;
}

/**
 * The result as JSON within the size limit: when a list is too long, whole rows are left out
 * (never cut mid-row) and the model is told how many, so it can narrow the question.
 */
export function fitResult(value: unknown, limit = MAX_RESULT): string {
  let json = JSON.stringify(value);
  if (json.length <= limit || !value || typeof value !== 'object') return json;
  const key = (['data', 'results', 'items'] as const).find((k) =>
    Array.isArray((value as Record<string, unknown>)[k]),
  );
  if (!key) return json;
  const rows = (value as Record<string, unknown[]>)[key]!;
  let keep = rows.length;
  while (keep > 1 && json.length > limit) {
    keep = Math.floor(keep * 0.7);
    json = JSON.stringify({
      ...(value as object),
      [key]: rows.slice(0, keep),
      omitted: `${rows.length - keep} more rows not shown; ask a narrower question or filter`,
    });
  }
  return json;
}

async function runTool(
  block: Extract<Block, { type: 'tool_use' }>,
  cfg: ConfigRow,
  ctx: RequestContext,
  user: AuthUser,
) {
  const excluded = json<string[]>(cfg.excluded_entities);
  let content: string;
  let isError = false;
  try {
    const hit = excluded.length ? touches(block.name, block.input) : [];
    if (hit.some((t) => t === '*' || excluded.includes(t)))
      throw new AppError('FORBIDDEN', 'The assistant may not use this record type');
    const asUser: AuthUser = { ...user, via: 'assistant' };
    let result = await callTool(
      block.name,
      block.input,
      { ctx: { ...ctx, user: asUser }, user: asUser },
      toolsAllowed(cfg, user),
    );
    // Excluded record types are filtered out of what the model sees.
    if (block.name === 'describe_schema' && excluded.length) {
      const schema = result as { recordTypes: { entity: string }[] };
      result = { recordTypes: schema.recordTypes.filter((t) => !excluded.includes(t.entity)) };
    }
    if (block.name === 'search_records' && excluded.length) {
      const found = result as { results: { type: string }[] };
      result = { results: found.results.filter((r) => !excluded.includes(r.type)) };
    }
    content = fitResult(compact(result));
  } catch (err) {
    isError = true;
    content = JSON.stringify(
      err instanceof AppError
        ? { error: err.code, message: err.message, details: err.details, hint: hintFor(err.code) }
        : { error: 'INTERNAL', hint: 'Something failed on the server; say so plainly and do not retry.' },
    );
    if (!(err instanceof AppError)) logger.error({ err, tool: block.name }, 'assistant tool failed');
  }
  // Errors and odd shapes that are still too long are cut as a last resort.
  if (content.length > MAX_RESULT) content = `${content.slice(0, MAX_RESULT)}… (truncated)`;
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  } as Block;
}

/** Tells the model what it may not read, so it says so instead of calling tools that are refused. */
function excludedNote(cfg: ConfigRow) {
  const excluded = json<string[]>(cfg.excluded_entities);
  return excluded.length
    ? `An admin has kept these record types away from you: ${excluded.join(', ')}. Do not call tools for them; if asked, say an admin turned that off in the assistant settings.`
    : '';
}

async function systemPrompt(cfg: ConfigRow, user: AuthUser) {
  const { appName } = await getBranding();
  return [
    `You are ${cfg.name}, the assistant inside ${appName}, a CRM. You help ${user.firstName} ${user.lastName}.`,
    `Today is ${today()}. Use the tools to look things up; never invent records, ids or numbers.`,
    'Call describe_schema to learn the record types and fields of this workspace before listing or changing records.',
    "Tools run with this person's permissions. When a tool returns an error, explain it plainly or try another way.",
    'To change data, call the write tool directly: the person sees each change and confirms it before it runs. Do not ask for permission in text first.',
    'Answer briefly, in plain language. Use Markdown: short lists, **bold** for key figures. Never show ids or uuids as text.',
    'When you mention a record a tool returned, link it as [Its name](record:<entity>/<uuid>), with the entity key and uuid from the tool result.',
    'For numbers, totals and trends use run_report rather than adding up listed records. To show a report as a chart, add a block on its own lines: ```chart then {"report": 1, "type": "bar", "title": "Deals by stage"} then ``` ("report" is which run_report of this answer, 1 for the first; "type" is bar, line, pie or table). The chart is drawn from that report\'s real result, so never write numbers into the block.',
    'End each answer with one last line: "Next: " then two or three short follow-up requests the person might send, separated by " | ", written as they would ask them. Leave it out when you asked them a question.',
    ...(excludedNote(cfg) ? [excludedNote(cfg)] : []),
    ...(setupAllowed(cfg, user) ? [SETUP_PROMPT, CONFIG_PROMPT] : []),
  ].join('\n');
}

/** Where a streamed request sends text and tool steps as they happen (absent: no streaming). */
interface Sink {
  text(delta: string): void;
  tool(title: string): void;
  /** The browser went away: stop before the next model call. */
  closed(): boolean;
}
const streamSink = new AsyncLocalStorage<Sink>();

/**
 * Answer as server-sent events when the client asks (`?stream=1`): `text` deltas, `tool` steps,
 * then `done` with the conversation, or `error`. Checks that can fail run before this, so a
 * refusal is still a normal JSON error.
 */
async function respond<T>(req: Request, res: Response, status: number, run: () => Promise<T>) {
  if (req.query.stream !== '1') return run();
  res.status(status);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  let closed = false;
  res.on('close', () => (closed = true));
  const send = (event: string, data: unknown) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    const result = await streamSink.run(
      {
        text: (delta) => !closed && send('text', { delta }),
        tool: (title) => !closed && send('tool', { title }),
        closed: () => closed,
      },
      run,
    );
    send('done', result);
  } catch (err) {
    send(
      'error',
      err instanceof AppError
        ? { code: err.code, message: err.message }
        : { code: 'INTERNAL', message: 'Something went wrong.' },
    );
    if (!(err instanceof AppError)) logger.error({ err }, 'assistant stream failed');
  }
  res.end();
  return undefined;
}

/** One model loop per person at a time, so concurrent requests cannot overshoot the caps together. */
const running = new Map<number, Promise<unknown>>();
function serialized<T>(userId: number, fn: () => Promise<T>): Promise<T> {
  const prev = running.get(userId) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  running.set(userId, next);
  void next.finally(() => running.get(userId) === next && running.delete(userId)).catch(() => undefined);
  return next;
}

/** Providers that report no usage are charged an estimate (about four characters a token). */
const estimate = (v: unknown) => Math.ceil(JSON.stringify(v).length / 4);

/** Ask the model, run read tools, and stop at an answer or at write proposals that need a decision. */
function advance(conv: { id: number }, cfg: ConfigRow, ctx: RequestContext, user: AuthUser) {
  return serialized(user.id, () => advanceNow(conv, cfg, ctx, user));
}

async function advanceNow(conv: { id: number }, cfg: ConfigRow, ctx: RequestContext, user: AuthUser) {
  const provider = await providerConfig(cfg);
  if (!provider) throw new AppError('NOT_FOUND', 'The assistant is not set up yet. An admin can set it up.');
  const tools = toolsAllowed(cfg, user).map((t) => ({
    name: t.name,
    description: t.description,
    schema: inputJsonSchema(t) as Record<string, unknown>,
  }));
  const system = await systemPrompt(cfg, user);
  for (let step = 0; step < MAX_STEPS; step++) {
    await assertWithinCaps(cfg, user.id);
    const messages = latestImagesOnly(await history(conv.id));
    const sink = streamSink.getStore();
    if (sink?.closed()) return;
    const reply = sink
      ? await chatStream(provider, { system, messages, tools }, { text: sink.text })
      : await chat(provider, { system, messages, tools });
    if (provider.provider !== 'simulated')
      await recordUsage(user.id, {
        input: reply.usage.input || estimate([system, messages]),
        output: reply.usage.output || estimate(reply.content),
      });
    const content = reply.content.length ? reply.content : [{ type: 'text' as const, text: '…' }];
    await append(conv.id, 'assistant', content);
    const uses = content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return;
    const defs = new Map(toolsAllowed(cfg, user).map((t) => [t.name, t]));
    // Read-only lookups run side by side; their results keep the order the model asked for them.
    const slots: (Block | Promise<Block>)[] = [];
    const proposals: Pending['proposals'] = [];
    for (const use of uses) {
      const def = defs.get(use.name);
      // A change that can never run is answered now, instead of asking the person to confirm it.
      const refused = def?.write ? await precheck(use, cfg, ctx, user) : null;
      // A tool_use must always get a result, or the conversation cannot continue.
      if (refused) slots.push(refused);
      else if (def?.write)
        proposals.push({
          id: `p${proposals.length + 1}`,
          toolUseId: use.id,
          name: use.name,
          title: def.title,
          input: use.input,
          ...(use.name === 'config_change'
            ? { detail: describeChange(String(use.input.method), String(use.input.path), use.input.body) }
            : {}),
        });
      else {
        streamSink.getStore()?.tool(def?.title ?? use.name);
        slots.push(runTool(use, cfg, ctx, user));
      }
    }
    const results = await Promise.all(slots);
    if (proposals.length) {
      await db(CONVERSATIONS)
        .where({ id: conv.id })
        .update({ pending: JSON.stringify({ results, proposals } satisfies Pending) });
      return;
    }
    await append(conv.id, 'user', results);
  }
  await append(conv.id, 'assistant', [
    { type: 'text', text: 'I stopped here because this took too many steps. Try a narrower question.' },
  ]);
}

/** A refusal result for a proposed change that cannot run, or null when it may be proposed. */
async function precheck(
  use: Extract<Block, { type: 'tool_use' }>,
  cfg: ConfigRow,
  ctx: RequestContext,
  user: AuthUser,
): Promise<Block | null> {
  if (use.name !== 'config_change') return null;
  const asUser: AuthUser = { ...user, via: 'assistant' };
  try {
    const excluded = json<string[]>(cfg.excluded_entities);
    const hit = excluded.length ? touches(use.name, use.input) : [];
    if (hit.some((t) => t === '*' || excluded.includes(t)))
      throw new AppError('FORBIDDEN', 'The assistant may not use this record type');
    await precheckConfigChange(use.input, { ctx: { ...ctx, user: asUser }, user: asUser });
    return null;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return {
      type: 'tool_result',
      tool_use_id: use.id,
      content: JSON.stringify({ error: err.code, message: err.message, details: err.details }),
      is_error: true,
    };
  }
}

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return null;
  }
};

interface ChartDto {
  title: string;
  definition: Record<string, unknown>;
  result: unknown;
}

const CHART_BLOCK = /```chart[ \t]*\n([\s\S]*?)```/g;
const chartSpec = z.object({
  report: z.number().int().min(1).max(20).optional(),
  type: z.enum(['bar', 'line', 'pie', 'table']).default('bar'),
  title: z.string().trim().max(120).optional(),
});

/**
 * Charts the model asked for: each block names one of this answer's reports and a chart type. The
 * numbers come from that report's real result, so a chart can never show made-up figures; a block
 * that names no report, or is malformed, is dropped.
 */
export function chartsIn(text: string, reports: { input: Record<string, unknown>; result: unknown }[]) {
  const charts: ChartDto[] = [];
  const body = text.replace(CHART_BLOCK, (_m, raw: string) => {
    const spec = chartSpec.safeParse(parseJson(raw.trim()));
    const report = spec.success ? reports[(spec.data.report ?? reports.length) - 1] : undefined;
    const result = report?.result as { rows?: unknown } | null | undefined;
    if (spec.success && report && result && Array.isArray(result.rows))
      charts.push({
        title: spec.data.title ?? '',
        definition: { ...report.input, chart: spec.data.type },
        result,
      });
    return '';
  });
  return { body: body.replace(/\n{3,}/g, '\n\n').trim(), charts };
}

/** One step the assistant took: the tool's title and, when it says, the record type or search. */
interface Step {
  title: string;
  entity?: string;
  query?: string;
}

function stepOf(b: Extract<Block, { type: 'tool_use' }>, title: string): Step {
  const entity = typeof b.input.entity === 'string' ? b.input.entity : undefined;
  const q = b.input.query ?? b.input.q;
  const query = typeof q === 'string' && q.trim() ? q.trim().slice(0, 60) : undefined;
  return { title, ...(entity ? { entity } : {}), ...(query ? { query } : {}) };
}

const uniqueSteps = (steps: Step[]) => [...new Map(steps.map((s) => [JSON.stringify(s), s])).values()];

/** What the web shows: text, tool activity and pending proposals (never raw tool output). */
async function conversationDto(uuid: string, user: AuthUser) {
  const conv = await conversationFor(uuid, user);
  const messages = await history(conv.id);
  const defs = new Map([...toolDefs(), ...SETUP_TOOLS, ...CONFIG_TOOLS].map((t) => [t.name, t]));
  const items: {
    role: 'user' | 'assistant';
    text?: string;
    tools?: string[];
    /** The same steps with what each looked at (a record type, a search), for people to check. */
    steps?: Step[];
    images?: string[];
    /** Charts the answer asked for, drawn from its run_report results (never the model's numbers). */
    charts?: ChartDto[];
  }[] = [];
  let reports: { input: Record<string, unknown>; result: unknown }[] = [];
  const reportInputs = new Map<string, Record<string, unknown>>();
  let details: Step[] = [];
  let imageNo = 0;
  // Steps the assistant took (tool calls, often with blank text) are gathered onto its next reply,
  // so one answer shows as one bubble instead of a row of empty ones.
  let steps: string[] = [];
  // Records the tools returned, so the answers can link them as chips whatever the model wrote.
  const asked = new Map<string, unknown>();
  const refs: RecordRef[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === 'tool_use') asked.set(b.id, b.input.entity);
      if (b.type === 'tool_use' && b.name === 'run_report') reportInputs.set(b.id, b.input);
      if (b.type === 'tool_result' && !b.is_error && reportInputs.has(b.tool_use_id))
        reports.push({ input: reportInputs.get(b.tool_use_id)!, result: parseJson(b.content) });
      if (b.type === 'tool_result' && !b.is_error)
        refs.push(...recordsIn(b.content, asked.get(b.tool_use_id)));
    }
    const text = m.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n')
      .trim();
    const tools = m.content.flatMap((b) =>
      b.type === 'tool_use' ? [defs.get(b.name)?.title ?? b.name] : [],
    );
    if (m.role === 'assistant') {
      steps = [...steps, ...tools];
      details = [
        ...details,
        ...m.content.flatMap((b) =>
          b.type === 'tool_use' ? [stepOf(b, defs.get(b.name)?.title ?? b.name)] : [],
        ),
      ];
      if (!text || text === '…') continue;
      const { body, charts } = chartsIn(text, reports);
      reports = [];
      items.push({
        role: m.role,
        text: linkRecords(body, refs),
        ...(charts.length ? { charts } : {}),
        ...(steps.length ? { tools: [...new Set(steps)], steps: uniqueSteps(details) } : {}),
      });
      steps = [];
      details = [];
    } else if (text) {
      if (steps.length)
        items.push({ role: 'assistant', tools: [...new Set(steps)], steps: uniqueSteps(details) });
      steps = [];
      details = [];
      // The note about the page on screen is for the model; people see their question as asked.
      const images = m.content
        .filter((b) => b.type === 'image')
        .map(() => `/m/assistant/conversations/${conv.uuid}/images/${imageNo++}`);
      items.push({ role: m.role, text: text.replace(PAGE_NOTE, ''), ...(images.length ? { images } : {}) });
    }
  }
  if (steps.length)
    items.push({ role: 'assistant', tools: [...new Set(steps)], steps: uniqueSteps(details) });
  const pending = conv.pending ? json<Pending>(conv.pending) : null;
  return { uuid: conv.uuid, title: conv.title, messages: items, proposals: pending?.proposals ?? [] };
}

// ---------------- Images ----------------

/** Up to three images per question, shrunk in the browser first (the request limit is 1 MB). */
const MAX_IMAGES = 3;
const MAX_IMAGE_BASE64 = 700_000;
const imagesSchema = z
  .array(
    z.object({
      mediaType: z.enum(IMAGE_TYPES),
      data: z
        .string()
        .max(MAX_IMAGE_BASE64)
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Base64 image data'),
    }),
  )
  .max(MAX_IMAGES)
  .optional();

/** The file's first bytes must match the type it claims, so nothing else passes as an image. */
function looksLike(mediaType: ImageType, data: string) {
  const head = Buffer.from(data.slice(0, 24), 'base64');
  const hex = head.toString('hex');
  if (mediaType === 'image/png') return hex.startsWith('89504e470d0a1a0a');
  if (mediaType === 'image/jpeg') return hex.startsWith('ffd8ff');
  if (mediaType === 'image/gif') return head.toString('latin1', 0, 4) === 'GIF8';
  return head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP';
}

/** The person's question as stored: their images first, then the text with the page note. */
function question(
  body: {
    text: string;
    context?: { entity: string; uuid?: string };
    images?: { mediaType: ImageType; data: string }[];
  },
  cfg: ConfigRow,
): Block[] {
  const images = body.images ?? [];
  if (images.length && !readsImagesNow(cfg))
    throw new AppError('VALIDATION_FAILED', 'This assistant reads text only, so images cannot be attached.');
  if (images.some((i) => !looksLike(i.mediaType, i.data)))
    throw new AppError('VALIDATION_FAILED', 'One of the attachments is not a PNG, JPEG, WebP or GIF image.');
  return [
    ...images.map((i) => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data })),
    { type: 'text', text: withContext(body.text, body.context) },
  ];
}

/**
 * Images reach the model with the question they came with only; earlier ones are replaced by a
 * short note, so they are not paid for again on every later turn.
 */
function latestImagesOnly(messages: ChatMessage[]): ChatMessage[] {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user' && m.content.some((b) => b.type === 'text')) last = i;
  });
  return messages.map((m, i) =>
    i === last || !m.content.some((b) => b.type === 'image')
      ? m
      : {
          ...m,
          content: m.content.map((b) =>
            b.type === 'image'
              ? { type: 'text' as const, text: '(An image the person attached earlier.)' }
              : b,
          ),
        },
  );
}

// ---------------- Routes ----------------

const uuidParam = z.object({ uuid: z.uuid() });

const routes = defineRoutes('/m/assistant', ['assistant'], 'assistant')
  .add({
    method: 'get',
    path: '/status',
    permission: 'assistant.chat.use',
    handler: async ({ user }) => {
      const cfg = await loadConfig();
      const ready = !!(await providerConfig(cfg));
      return { name: cfg.name, ready, setup: setupAllowed(cfg, user), vision: ready && readsImagesNow(cfg) };
    },
  })
  .add({
    method: 'get',
    path: '/config',
    permission: 'assistant.settings.manage',
    handler: async () => {
      const cfg = await loadConfig();
      const { profile } = await effectiveCompliance();
      return { ...configDto(cfg), complianceProfile: profile };
    },
  })
  .add({
    method: 'patch',
    path: '/config',
    permission: 'assistant.settings.manage',
    body: configSchema,
    handler: async ({ ctx, user, body: input }) => {
      const cfg = await loadConfig();
      if (input.setupEnabled !== undefined && !user.isAdmin)
        throw new AppError('FORBIDDEN', 'Only admins can let the assistant set up the workspace');
      // A listed provider brings its own format, address and headers.
      const simulated = input.preset === SIMULATED.id && allowsTestingAids();
      const preset = input.preset && !simulated ? findPreset(input.preset) : undefined;
      if (input.preset && !preset && !simulated)
        throw new AppError('VALIDATION_FAILED', 'Choose a provider from the list');
      // Simulated replies keep the saved provider address, key and headers for switching back.
      const body = simulated
        ? {
            ...input,
            provider: 'simulated' as const,
            model: SIMULATED.recommended[0],
            baseUrl: undefined,
            apiKey: undefined,
            headers: undefined,
          }
        : preset
          ? { ...input, provider: preset.format, baseUrl: preset.baseUrl, headers: preset.headers }
          : input;
      if (body.baseUrl) await assertSafeModelUrl(body.baseUrl);
      const reserved = Object.keys(body.headers ?? {}).filter((h) => RESERVED_HEADERS.has(h.toLowerCase()));
      if (reserved.length)
        throw new AppError('VALIDATION_FAILED', 'These headers are set by the app', [
          { path: 'headers', message: `Remove ${reserved.join(', ')}` },
        ]);
      const patch: Record<string, unknown> = { updated_at: new Date() };
      // A new address must come with its key, so the saved key is never sent somewhere else.
      const moved =
        (body.baseUrl !== undefined && body.baseUrl !== cfg.base_url) ||
        (body.provider !== undefined &&
          body.provider !== cfg.provider &&
          body.provider !== 'simulated' &&
          cfg.provider !== 'simulated');
      if (moved && body.apiKey === undefined) patch.api_key_enc = null;
      if (body.name !== undefined) patch.name = body.name;
      if (body.provider !== undefined) patch.provider = body.provider;
      if (body.baseUrl !== undefined) patch.base_url = body.baseUrl;
      if (body.model !== undefined) patch.model = body.model;
      if (body.apiKey !== undefined)
        patch.api_key_enc = body.apiKey === null ? null : encrypt(body.apiKey, KEY_AAD);
      if (body.headers !== undefined) patch.headers = JSON.stringify(body.headers);
      if (body.monthlyTokenCap !== undefined) patch.monthly_token_cap = body.monthlyTokenCap;
      if (body.userDailyTokenCap !== undefined) patch.user_daily_token_cap = body.userDailyTokenCap;
      if (body.retentionDays !== undefined) patch.retention_days = body.retentionDays;
      if (body.excludedEntities !== undefined)
        patch.excluded_entities = JSON.stringify(body.excludedEntities);
      if (body.hipaaAcknowledged !== undefined) patch.hipaa_acknowledged = body.hipaaAcknowledged;
      if (input.preset !== undefined) patch.preset = input.preset ?? null;
      if (body.setupEnabled !== undefined) patch.setup_enabled = body.setupEnabled;
      if (body.vision !== undefined) patch.vision = body.vision;
      await db.transaction(async (trx) => {
        await trx(CONFIG).where({ id: cfg.id }).update(patch);
        // Secrets are never written to the audit log, only that they changed.
        const { apiKey, headers, ...rest } = body;
        await audit(trx, ctx, {
          action: 'assistant.config.updated',
          entity: 'assistant.config',
          diff: {
            ...rest,
            ...(apiKey !== undefined ? { apiKey: '(changed)' } : {}),
            ...(headers ? { headers: Object.keys(headers) } : {}),
          },
        });
      });
      return configDto(await loadConfig());
    },
  })
  .add({
    method: 'get',
    path: '/providers',
    permission: 'assistant.settings.manage',
    summary: 'AI providers an admin can pick, with where to get a key and the recommended models',
    handler: async () => ({
      data: presets(),
      // Starting points for a compatible server; `allowed` says whether a local one is reachable.
      compatible: compatibleServers().map((c) => ({
        ...c,
        allowed: !c.local || modelHosts().includes(new URL(c.baseUrl).host.toLowerCase()),
      })),
    }),
  })
  .add({
    method: 'post',
    path: '/models',
    permission: 'assistant.settings.manage',
    body: z.object({
      preset: z
        .string()
        .regex(/^[a-z][a-z0-9-]{1,39}$/)
        .nullish(),
      provider: z.enum(WIRE_FORMATS).nullish(),
      baseUrl: z
        .url({ protocol: /^https?$/ })
        .max(500)
        .nullish(),
      /** Omitted: the saved key, but only for the saved address. */
      apiKey: z.string().min(1).max(500).nullish(),
    }),
    summary: "The provider's models, recommended ones first",
    handler: async ({ body }) => {
      if (body.preset === SIMULATED.id && allowsTestingAids())
        return { data: rankModels([...SIMULATED.recommended], [...SIMULATED.recommended]) };
      const cfg = await loadConfig();
      const preset = findPreset(body.preset);
      const provider = preset?.format ?? body.provider ?? (cfg.provider as ProviderConfig['provider'] | null);
      const baseUrl = preset?.baseUrl ?? body.baseUrl ?? cfg.base_url;
      if (!provider || !baseUrl) throw new AppError('VALIDATION_FAILED', 'Choose a provider first');
      // The saved key only ever goes to the address it was saved for.
      const apiKey =
        body.apiKey ??
        (cfg.api_key_enc && baseUrl === cfg.base_url ? decrypt(cfg.api_key_enc, KEY_AAD) : null);
      if (!apiKey && preset) throw new AppError('VALIDATION_FAILED', 'Enter the API key first');
      const headers =
        preset?.headers ?? (baseUrl === cfg.base_url ? json<Record<string, string>>(cfg.headers) : {});
      const ids = await listModels({ provider, baseUrl, apiKey: apiKey ?? '', headers });
      return { data: rankModels(ids, preset?.recommended ?? []) };
    },
  })
  .add({
    method: 'post',
    path: '/test',
    permission: 'assistant.settings.manage',
    summary: 'Send one short message with the saved settings to check they work',
    handler: async ({ ctx }) => {
      const cfg = await loadConfig();
      const provider = await providerConfig(cfg);
      if (!provider) throw new AppError('VALIDATION_FAILED', 'Save a provider, model and API key first');
      const started = Date.now();
      const reply = await chat(provider, {
        system: 'Reply with the single word: ready',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Are you there?' }] }],
        tools: [],
      });
      await audit(db, ctx, { action: 'assistant.config.tested', entity: 'assistant.config', diff: {} });
      return {
        ok: true,
        ms: Date.now() - started,
        reply: reply.content
          .flatMap((b) => (b.type === 'text' ? [b.text] : []))
          .join(' ')
          .slice(0, 200),
      };
    },
  })
  .add({
    method: 'get',
    path: '/usage',
    permission: 'assistant.settings.manage',
    handler: async () => {
      const month = today().slice(0, 7);
      const rows = (await db(`${USAGE} as u`)
        .join('users', 'users.id', 'u.user_id')
        .where('u.day', '>=', `${month}-01`)
        .groupBy('users.id', 'users.first_name', 'users.last_name')
        .select('users.first_name', 'users.last_name')
        .sum({ requests: 'u.requests', input: 'u.input_tokens', output: 'u.output_tokens' })) as Record<
        string,
        unknown
      >[];
      return {
        month,
        data: rows.map((r) => ({
          name: `${r.first_name} ${r.last_name}`.trim(),
          requests: Number(r.requests),
          inputTokens: Number(r.input),
          outputTokens: Number(r.output),
        })),
      };
    },
  })
  .add({
    method: 'get',
    path: '/conversations',
    permission: 'assistant.chat.use',
    handler: async ({ user }) => ({
      data: (
        await db(CONVERSATIONS)
          .where({ user_id: user.id })
          .orderBy('updated_at', 'desc')
          .limit(50)
          .select('uuid', 'title', 'updated_at')
      ).map((r) => ({ uuid: r.uuid, title: r.title, updatedAt: new Date(r.updated_at).toISOString() })),
    }),
  })
  .add({
    method: 'post',
    path: '/conversations',
    permission: 'assistant.chat.use',
    status: 201,
    body: z.object({
      text: z.string().trim().min(1).max(4000),
      /** The record the person is looking at. */
      /** The page on screen, as ids only: a record, or a list of one type (no uuid). */
      context: z
        .object({ entity: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), uuid: z.uuid().optional() })
        .optional(),
      images: imagesSchema,
    }),
    handler: async ({ req, res, ctx, user, body }) => {
      const cfg = await loadConfig();
      if (!(await providerConfig(cfg)))
        throw new AppError('NOT_FOUND', 'The assistant is not set up yet. An admin can set it up.');
      question(body, cfg); // Refuse images the model cannot read before anything is stored.
      const uuid = newUuid();
      const [id] = await db(CONVERSATIONS).insert({ uuid, user_id: user.id, title: body.text.slice(0, 120) });
      // Conversation text stays out of the audit log; only that it exists.
      await audit(db, ctx, {
        action: 'assistant.conversation.created',
        entity: 'assistant.conversation',
        entityId: id!,
        entityUuid: uuid,
      });
      await append(id!, 'user', question(body, cfg));
      return respond(req, res, 201, async () => {
        await advance({ id: id! }, cfg, ctx, user);
        return conversationDto(uuid, user);
      });
    },
  })
  .add({
    method: 'get',
    path: '/conversations/:uuid',
    permission: 'assistant.chat.use',
    params: uuidParam,
    handler: ({ user, params }) => conversationDto(params.uuid, user),
  })
  .add({
    method: 'get',
    path: '/conversations/:uuid/images/:n',
    permission: 'assistant.chat.use',
    params: z.object({ uuid: z.uuid(), n: z.coerce.number().int().min(0).max(10_000) }),
    summary: 'An image the person attached, in the order they were attached',
    handler: async ({ res, user, params }) => {
      const conv = await conversationFor(params.uuid, user);
      const image = (await history(conv.id))
        .flatMap((m) => (m.role === 'user' ? m.content : []))
        .filter((b): b is Extract<Block, { type: 'image' }> => b.type === 'image')[params.n];
      if (!image) throw notFound('Image');
      res.set('Content-Type', image.mediaType);
      res.set('Cache-Control', 'private, max-age=86400');
      res.set('X-Content-Type-Options', 'nosniff');
      res.set('Content-Security-Policy', "default-src 'none'");
      res.send(Buffer.from(image.data, 'base64'));
    },
  })
  .add({
    method: 'post',
    path: '/conversations/:uuid/messages',
    permission: 'assistant.chat.use',
    params: uuidParam,
    body: z.object({
      text: z.string().trim().min(1).max(4000),
      /** The page on screen, as ids only: a record, or a list of one type (no uuid). */
      context: z
        .object({ entity: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), uuid: z.uuid().optional() })
        .optional(),
      images: imagesSchema,
    }),
    handler: async ({ req, res, ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      if (conv.pending) throw new AppError('CONFLICT', 'Confirm or decline the proposed changes first');
      const cfg = await loadConfig();
      await append(conv.id, 'user', question(body, cfg));
      return respond(req, res, 200, async () => {
        await advance(conv, cfg, ctx, user);
        return conversationDto(params.uuid, user);
      });
    },
  })
  .add({
    method: 'post',
    path: '/conversations/:uuid/retry',
    permission: 'assistant.chat.use',
    params: uuidParam,
    summary: 'Ask the last question again, as it was or edited (its answer and waiting changes are dropped)',
    body: z.object({ text: z.string().trim().min(1).max(4000).optional() }),
    handler: async ({ req, res, ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      const rows = (await db(MESSAGES).where({ conversation_id: conv.id }).orderBy('id', 'desc')) as {
        id: number;
        role: string;
        content: Block[] | string;
      }[];
      const last = rows.find(
        (r) => r.role === 'user' && json<Block[]>(r.content).some((b) => b.type === 'text'),
      );
      if (!last) throw new AppError('CONFLICT', 'There is no question to ask again');
      const cfg = await loadConfig();
      await db.transaction(async (trx) => {
        // Proposed changes never ran, so dropping them with the answer they belong to is safe.
        await trx(MESSAGES).where({ conversation_id: conv.id }).where('id', '>', last.id).delete();
        await trx(CONVERSATIONS).where({ id: conv.id }).update({ pending: null, updated_at: new Date() });
        if (body.text !== undefined) {
          // An edit keeps the question's images and the note about the page it was asked on.
          const content = json<Block[]>(last.content).map((b) =>
            b.type === 'text'
              ? { type: 'text' as const, text: `${body.text}${PAGE_NOTE.exec(b.text)?.[0] ?? ''}` }
              : b,
          );
          await trx(MESSAGES)
            .where({ id: last.id })
            .update({ content: JSON.stringify(content) });
        }
      });
      return respond(req, res, 200, async () => {
        await advance(conv, cfg, ctx, user);
        return conversationDto(params.uuid, user);
      });
    },
  })
  .add({
    method: 'post',
    path: '/conversations/:uuid/decisions',
    permission: 'assistant.chat.use',
    params: uuidParam,
    body: z.object({ decisions: z.record(z.string().max(200), z.boolean()) }),
    handler: async ({ req, res, ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      if (!conv.pending) throw new AppError('CONFLICT', 'Nothing is waiting for a decision');
      // Claim the proposals under a row lock: a double click or a retry cannot run a change twice.
      const claimed = await db.transaction(async (trx) => {
        const row = await trx(CONVERSATIONS).where({ id: conv.id }).forUpdate().first('pending');
        if (!row?.pending) return null;
        await trx(CONVERSATIONS).where({ id: conv.id }).update({ pending: null });
        return row.pending as Pending | string;
      });
      if (!claimed) throw new AppError('CONFLICT', 'These changes were already decided');
      const cfg = await loadConfig();
      const pending = json<Pending>(claimed);
      const results = [...pending.results];
      for (const p of pending.proposals) {
        // Only what the person explicitly confirmed runs, with exactly the input they saw.
        const approved = body.decisions[p.id] === true;
        if (approved)
          results.push(
            await runTool(
              { type: 'tool_use', id: p.toolUseId, name: p.name, input: p.input },
              cfg,
              ctx,
              user,
            ),
          );
        else
          results.push({
            type: 'tool_result',
            tool_use_id: p.toolUseId,
            content: 'The person declined this change.',
            is_error: true,
          });
        await audit(db, ctx, {
          action: approved ? 'assistant.change.confirmed' : 'assistant.change.declined',
          entity: 'assistant.conversation',
          entityId: conv.id,
          entityUuid: conv.uuid,
          diff: { tool: p.name },
        });
      }
      await append(conv.id, 'user', results);
      return respond(req, res, 200, async () => {
        try {
          await advance(conv, cfg, ctx, user);
        } catch (err) {
          // The confirmed changes already ran: say so instead of failing the whole request.
          const message = err instanceof AppError ? err.message : 'The assistant could not continue.';
          await append(conv.id, 'assistant', [{ type: 'text', text: `Your changes were made. ${message}` }]);
        }
        return conversationDto(params.uuid, user);
      });
    },
  })
  .add({
    method: 'delete',
    path: '/conversations/:uuid',
    permission: 'assistant.chat.use',
    params: uuidParam,
    handler: async ({ ctx, user, params }) => {
      const conv = await conversationFor(params.uuid, user);
      await db.transaction(async (trx) => {
        await trx(CONVERSATIONS).where({ id: conv.id }).delete();
        await audit(trx, ctx, {
          action: 'assistant.conversation.deleted',
          entity: 'assistant.conversation',
          entityId: conv.id,
          entityUuid: conv.uuid,
        });
      });
    },
  });

const PAGE_NOTE = /\n\n\(The person is looking at [^)]*\)$/;

function withContext(text: string, context?: { entity: string; uuid?: string }) {
  if (!context) return text;
  return context.uuid
    ? `${text}\n\n(The person is looking at ${context.entity} ${context.uuid}.)`
    : `${text}\n\n(The person is looking at the list of ${context.entity} records.)`;
}

/**
 * Conversations can quote a person's details from tool results. Matching is case-insensitive over
 * messages, titles and pending results; erasure deletes whole conversations (a partial one could not
 * continue), and access requests export the matching messages.
 */
const privacy: PrivacyHandler = {
  key: 'assistant',
  tables: [MESSAGES],
  viewPermission: 'assistant.settings.manage',
  async export(subject, conn) {
    const ids = await mentioning(subject, conn);
    const rows = ids.length
      ? await conn(MESSAGES)
          .whereIn('conversation_id', ids)
          .orderBy('id')
          .select('created_at', 'role', 'content')
      : [];
    return { messages: rows };
  },
  async erase(subject, trx) {
    const ids = await mentioning(subject, trx);
    const n = ids.length ? await trx(CONVERSATIONS).whereIn('id', ids).delete() : 0;
    return { cleared: { conversations: n } };
  },
};

/** Conversations whose messages, title or pending results mention the person's id or email. */
async function mentioning(
  subject: { uuid: string; email: string | null },
  conn: typeof db,
): Promise<number[]> {
  const terms = [subject.uuid, subject.email]
    .filter((t): t is string => !!t)
    .map((t) => `%${escapeLike(t.toLowerCase())}%`);
  const like = (col: string) => (w: Knex.QueryBuilder) => {
    for (const t of terms) w.orWhereRaw(`LOWER(CAST(${col} AS CHAR)) LIKE ?`, [t]);
  };
  const fromMessages = await conn(MESSAGES)
    .where(like('content'))
    .distinct('conversation_id')
    .pluck('conversation_id');
  const fromConversations = await conn(CONVERSATIONS)
    .where((w) => {
      like('title')(w);
      like('pending')(w);
    })
    .pluck('id');
  return [...new Set([...fromMessages, ...fromConversations].map(Number))];
}

export const assistant: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_assistant': m0001, '0002_presets': m0002, '0003_vision': m0003 },
  privacy,
  // Conversations are kept for the configured number of days (30 by default).
  start: () =>
    every(6 * 60 * 60_000, 'assistant.retention', async () => {
      if (!isModuleEnabled('assistant')) return;
      const cfg = await loadConfig();
      await db(CONVERSATIONS)
        .where('updated_at', '<', new Date(Date.now() - cfg.retention_days * 86_400_000))
        .delete();
    }),
};
