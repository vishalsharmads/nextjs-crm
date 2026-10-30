import { z } from 'zod';
import {
  AppError,
  assertSafeUrl,
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
import {
  chat,
  chatStream,
  listModels,
  PROVIDERS,
  type Block,
  type ChatMessage,
  type ProviderConfig,
} from './providers';
import { findPreset, providerPresets, rankModels } from './catalog';
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
}

const json = <T>(v: T | string): T => (typeof v === 'string' ? (JSON.parse(v) as T) : v);

async function loadConfig(): Promise<ConfigRow> {
  const row = (await db(CONFIG).orderBy('id').first()) as ConfigRow | undefined;
  if (row) return row;
  await db(CONFIG).insert({ headers: '{}', excluded_entities: '[]' });
  return (await db(CONFIG).orderBy('id').first()) as ConfigRow;
}

/** Usable when an admin set provider, model and key, and (under hipaa) acknowledged the risk. */
async function providerConfig(row: ConfigRow): Promise<ProviderConfig | null> {
  if (!row.provider || !row.base_url || !row.model || !row.api_key_enc) return null;
  const { profile } = await effectiveCompliance();
  if (profile === 'hipaa' && !row.hipaa_acknowledged) return null;
  return {
    provider: row.provider as ProviderConfig['provider'],
    baseUrl: row.base_url,
    model: row.model,
    apiKey: decrypt(row.api_key_enc, KEY_AAD),
    headers: json<Record<string, string>>(row.headers),
  };
}

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
  provider: z.enum(PROVIDERS).nullish(),
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
  proposals: { id: string; toolUseId: string; name: string; title: string; input: Record<string, unknown> }[];
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
  return setupAllowed(cfg, user) ? [...toolDefs(), ...SETUP_TOOLS] : toolDefs();
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
      return []; // Workspace configuration, never records.
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
    content = JSON.stringify(result);
  } catch (err) {
    isError = true;
    content = JSON.stringify(
      err instanceof AppError
        ? { error: err.code, message: err.message, details: err.details }
        : { error: 'INTERNAL' },
    );
    if (!(err instanceof AppError)) logger.error({ err, tool: block.name }, 'assistant tool failed');
  }
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
    'End each answer with one last line: "Next: " then two or three short follow-up requests the person might send, separated by " | ", written as they would ask them. Leave it out when you asked them a question.',
    ...(excludedNote(cfg) ? [excludedNote(cfg)] : []),
    ...(setupAllowed(cfg, user) ? [SETUP_PROMPT] : []),
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
    const messages = await history(conv.id);
    const sink = streamSink.getStore();
    if (sink?.closed()) return;
    const reply = sink
      ? await chatStream(provider, { system, messages, tools }, { text: sink.text })
      : await chat(provider, { system, messages, tools });
    await recordUsage(user.id, {
      input: reply.usage.input || estimate([system, messages]),
      output: reply.usage.output || estimate(reply.content),
    });
    const content = reply.content.length ? reply.content : [{ type: 'text' as const, text: '…' }];
    await append(conv.id, 'assistant', content);
    const uses = content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return;
    const defs = new Map(toolsAllowed(cfg, user).map((t) => [t.name, t]));
    const results: Block[] = [];
    const proposals: Pending['proposals'] = [];
    for (const use of uses) {
      const def = defs.get(use.name);
      // A tool_use must always get a result, or the conversation cannot continue.
      if (def?.write)
        proposals.push({
          id: `p${proposals.length + 1}`,
          toolUseId: use.id,
          name: use.name,
          title: def.title,
          input: use.input,
        });
      else {
        streamSink.getStore()?.tool(def?.title ?? use.name);
        results.push(await runTool(use, cfg, ctx, user));
      }
    }
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

/** What the web shows: text, tool activity and pending proposals (never raw tool output). */
async function conversationDto(uuid: string, user: AuthUser) {
  const conv = await conversationFor(uuid, user);
  const messages = await history(conv.id);
  const defs = new Map([...toolDefs(), ...SETUP_TOOLS].map((t) => [t.name, t]));
  const items: { role: 'user' | 'assistant'; text?: string; tools?: string[] }[] = [];
  // Steps the assistant took (tool calls, often with blank text) are gathered onto its next reply,
  // so one answer shows as one bubble instead of a row of empty ones.
  let steps: string[] = [];
  for (const m of messages) {
    const text = m.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n')
      .trim();
    const tools = m.content.flatMap((b) =>
      b.type === 'tool_use' ? [defs.get(b.name)?.title ?? b.name] : [],
    );
    if (m.role === 'assistant') {
      steps = [...steps, ...tools];
      if (!text || text === '…') continue;
      items.push({ role: m.role, text, ...(steps.length ? { tools: [...new Set(steps)] } : {}) });
      steps = [];
    } else if (text) {
      if (steps.length) items.push({ role: 'assistant', tools: [...new Set(steps)] });
      steps = [];
      items.push({ role: m.role, text });
    }
  }
  if (steps.length) items.push({ role: 'assistant', tools: [...new Set(steps)] });
  const pending = conv.pending ? json<Pending>(conv.pending) : null;
  return { uuid: conv.uuid, title: conv.title, messages: items, proposals: pending?.proposals ?? [] };
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
      return { name: cfg.name, ready: !!(await providerConfig(cfg)), setup: setupAllowed(cfg, user) };
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
      const preset = input.preset ? findPreset(input.preset) : undefined;
      if (input.preset && !preset) throw new AppError('VALIDATION_FAILED', 'Choose a provider from the list');
      const body = preset
        ? { ...input, provider: preset.format, baseUrl: preset.baseUrl, headers: preset.headers }
        : input;
      if (body.baseUrl) await assertSafeUrl(body.baseUrl, 'baseUrl');
      const reserved = Object.keys(body.headers ?? {}).filter((h) => RESERVED_HEADERS.has(h.toLowerCase()));
      if (reserved.length)
        throw new AppError('VALIDATION_FAILED', 'These headers are set by the app', [
          { path: 'headers', message: `Remove ${reserved.join(', ')}` },
        ]);
      const patch: Record<string, unknown> = { updated_at: new Date() };
      // A new address must come with its key, so the saved key is never sent somewhere else.
      const moved =
        (body.baseUrl !== undefined && body.baseUrl !== cfg.base_url) ||
        (body.provider !== undefined && body.provider !== cfg.provider);
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
      data: providerPresets().map((p) => ({
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
      provider: z.enum(PROVIDERS).nullish(),
      baseUrl: z
        .url({ protocol: /^https?$/ })
        .max(500)
        .nullish(),
      /** Omitted: the saved key, but only for the saved address. */
      apiKey: z.string().min(1).max(500).nullish(),
    }),
    summary: "The provider's models, recommended ones first",
    handler: async ({ body }) => {
      const cfg = await loadConfig();
      const preset = findPreset(body.preset);
      const provider = preset?.format ?? body.provider ?? (cfg.provider as ProviderConfig['provider'] | null);
      const baseUrl = preset?.baseUrl ?? body.baseUrl ?? cfg.base_url;
      if (!provider || !baseUrl) throw new AppError('VALIDATION_FAILED', 'Choose a provider first');
      // The saved key only ever goes to the address it was saved for.
      const apiKey =
        body.apiKey ??
        (cfg.api_key_enc && baseUrl === cfg.base_url ? decrypt(cfg.api_key_enc, KEY_AAD) : null);
      if (!apiKey) throw new AppError('VALIDATION_FAILED', 'Enter the API key first');
      const headers =
        preset?.headers ?? (baseUrl === cfg.base_url ? json<Record<string, string>>(cfg.headers) : {});
      const ids = await listModels({ provider, baseUrl, apiKey, headers });
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
      context: z.object({ entity: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), uuid: z.uuid() }).optional(),
    }),
    handler: async ({ req, res, ctx, user, body }) => {
      const cfg = await loadConfig();
      if (!(await providerConfig(cfg)))
        throw new AppError('NOT_FOUND', 'The assistant is not set up yet. An admin can set it up.');
      const uuid = newUuid();
      const [id] = await db(CONVERSATIONS).insert({ uuid, user_id: user.id, title: body.text.slice(0, 120) });
      // Conversation text stays out of the audit log; only that it exists.
      await audit(db, ctx, {
        action: 'assistant.conversation.created',
        entity: 'assistant.conversation',
        entityId: id!,
        entityUuid: uuid,
      });
      await append(id!, 'user', [{ type: 'text', text: withContext(body.text, body.context) }]);
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
    method: 'post',
    path: '/conversations/:uuid/messages',
    permission: 'assistant.chat.use',
    params: uuidParam,
    body: z.object({
      text: z.string().trim().min(1).max(4000),
      context: z.object({ entity: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/), uuid: z.uuid() }).optional(),
    }),
    handler: async ({ req, res, ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      if (conv.pending) throw new AppError('CONFLICT', 'Confirm or decline the proposed changes first');
      await append(conv.id, 'user', [{ type: 'text', text: withContext(body.text, body.context) }]);
      const cfg = await loadConfig();
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

function withContext(text: string, context?: { entity: string; uuid: string }) {
  return context ? `${text}\n\n(The person is looking at ${context.entity} ${context.uuid}.)` : text;
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
  migrations: { '0001_assistant': m0001, '0002_presets': m0002 },
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
