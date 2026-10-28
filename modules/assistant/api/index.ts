import { z } from 'zod';
import {
  AppError,
  audit,
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
} from '@app/api/module-api';
import * as m0001 from './migrations/0001_assistant';
import { chat, PROVIDERS, type Block, type ChatMessage, type ProviderConfig } from './providers';

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
});

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
  /** Write tools waiting for the person to confirm or decline. */
  proposals: { id: string; name: string; title: string; input: Record<string, unknown> }[];
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

/** Every tool; excluded record types are refused per call in `runTool`. */
function toolsAllowed(_cfg: ConfigRow): ToolDef[] {
  return toolDefs();
}

/** Runs a tool as the person, tagged `assistant` in the audit log; errors go back to the model. */
async function runTool(
  block: Extract<Block, { type: 'tool_use' }>,
  cfg: ConfigRow,
  ctx: RequestContext,
  user: AuthUser,
) {
  const excluded = json<string[]>(cfg.excluded_entities);
  const target = (block.input.entity ?? (block.input.related as { type?: string } | undefined)?.type) as
    string | undefined;
  let content: string;
  let isError = false;
  try {
    if (target && excluded.includes(target))
      throw new AppError('FORBIDDEN', 'The assistant may not use this record type');
    const asUser: AuthUser = { ...user, via: 'assistant' };
    const result = await callTool(
      block.name,
      block.input,
      { ctx: { ...ctx, user: asUser }, user: asUser },
      toolsAllowed(cfg),
    );
    content = JSON.stringify(result);
    // Lists of excluded record types are filtered out of what the model sees.
    if (block.name === 'describe_schema' && excluded.length) {
      const schema = result as { recordTypes: { entity: string }[] };
      content = JSON.stringify({
        recordTypes: schema.recordTypes.filter((t) => !excluded.includes(t.entity)),
      });
    }
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

async function systemPrompt(cfg: ConfigRow, user: AuthUser) {
  const { appName } = await getBranding();
  return [
    `You are ${cfg.name}, the assistant inside ${appName}, a CRM. You help ${user.firstName} ${user.lastName}.`,
    `Today is ${today()}. Use the tools to look things up; never invent records, ids or numbers.`,
    'Call describe_schema to learn the record types and fields of this workspace before listing or changing records.',
    "Tools run with this person's permissions. When a tool returns an error, explain it plainly or try another way.",
    'To change data, call the write tool directly: the person sees each change and confirms it before it runs. Do not ask for permission in text first.',
    'Answer briefly, in plain language. Refer to records by name, not id.',
  ].join('\n');
}

/** Ask the model, run read tools, and stop at an answer or at write proposals that need a decision. */
async function advance(conv: { id: number }, cfg: ConfigRow, ctx: RequestContext, user: AuthUser) {
  const provider = await providerConfig(cfg);
  if (!provider) throw new AppError('NOT_FOUND', 'The assistant is not set up yet. An admin can set it up.');
  const tools = toolsAllowed(cfg).map((t) => ({
    name: t.name,
    description: t.description,
    schema: inputJsonSchema(t) as Record<string, unknown>,
  }));
  const system = await systemPrompt(cfg, user);
  for (let step = 0; step < MAX_STEPS; step++) {
    await assertWithinCaps(cfg, user.id);
    const reply = await chat(provider, { system, messages: await history(conv.id), tools });
    await recordUsage(user.id, reply.usage);
    const content = reply.content.length ? reply.content : [{ type: 'text' as const, text: '…' }];
    await append(conv.id, 'assistant', content);
    const uses = content.filter((b): b is Extract<Block, { type: 'tool_use' }> => b.type === 'tool_use');
    if (!uses.length) return;
    const defs = new Map(toolDefs().map((t) => [t.name, t]));
    const results: Block[] = [];
    const proposals: Pending['proposals'] = [];
    for (const use of uses) {
      const def = defs.get(use.name);
      if (def?.write) proposals.push({ id: use.id, name: use.name, title: def.title, input: use.input });
      else results.push(await runTool(use, cfg, ctx, user));
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
  const defs = new Map(toolDefs().map((t) => [t.name, t]));
  const items: { role: 'user' | 'assistant'; text?: string; tools?: string[] }[] = [];
  for (const m of messages) {
    const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
    const tools = m.content.flatMap((b) =>
      b.type === 'tool_use' ? [defs.get(b.name)?.title ?? b.name] : [],
    );
    if (text || tools.length)
      items.push({ role: m.role, ...(text ? { text } : {}), ...(tools.length ? { tools } : {}) });
  }
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
    handler: async () => {
      const cfg = await loadConfig();
      return { name: cfg.name, ready: !!(await providerConfig(cfg)) };
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
    handler: async ({ ctx, body }) => {
      const cfg = await loadConfig();
      const patch: Record<string, unknown> = { updated_at: new Date() };
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
    handler: async ({ ctx, user, body }) => {
      const cfg = await loadConfig();
      if (!(await providerConfig(cfg)))
        throw new AppError('NOT_FOUND', 'The assistant is not set up yet. An admin can set it up.');
      const uuid = newUuid();
      const [id] = await db(CONVERSATIONS).insert({ uuid, user_id: user.id, title: body.text.slice(0, 120) });
      await append(id!, 'user', [{ type: 'text', text: withContext(body.text, body.context) }]);
      await advance({ id: id! }, cfg, ctx, user);
      return conversationDto(uuid, user);
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
    handler: async ({ ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      if (conv.pending) throw new AppError('CONFLICT', 'Confirm or decline the proposed changes first');
      await append(conv.id, 'user', [{ type: 'text', text: withContext(body.text, body.context) }]);
      await advance(conv, await loadConfig(), ctx, user);
      return conversationDto(params.uuid, user);
    },
  })
  .add({
    method: 'post',
    path: '/conversations/:uuid/decisions',
    permission: 'assistant.chat.use',
    params: uuidParam,
    body: z.object({ decisions: z.record(z.string().max(200), z.boolean()) }),
    handler: async ({ ctx, user, params, body }) => {
      const conv = await conversationFor(params.uuid, user);
      if (!conv.pending) throw new AppError('CONFLICT', 'Nothing is waiting for a decision');
      const cfg = await loadConfig();
      const pending = json<Pending>(conv.pending);
      const results = [...pending.results];
      for (const p of pending.proposals) {
        // Only what the person explicitly confirmed runs; anything else is declined.
        if (body.decisions[p.id] === true)
          results.push(
            await runTool({ type: 'tool_use', id: p.id, name: p.name, input: p.input }, cfg, ctx, user),
          );
        else
          results.push({
            type: 'tool_result',
            tool_use_id: p.id,
            content: 'The person declined this change.',
            is_error: true,
          });
      }
      await db(CONVERSATIONS).where({ id: conv.id }).update({ pending: null });
      await append(conv.id, 'user', results);
      await advance(conv, cfg, ctx, user);
      return conversationDto(params.uuid, user);
    },
  })
  .add({
    method: 'delete',
    path: '/conversations/:uuid',
    permission: 'assistant.chat.use',
    params: uuidParam,
    handler: async ({ user, params }) => {
      const conv = await conversationFor(params.uuid, user);
      await db(CONVERSATIONS).where({ id: conv.id }).delete();
    },
  });

function withContext(text: string, context?: { entity: string; uuid: string }) {
  return context ? `${text}\n\n(The person is looking at ${context.entity} ${context.uuid}.)` : text;
}

/**
 * Conversations can quote a person's details from tool results. Access requests list the messages
 * that mention them; erasure deletes those messages.
 */
const privacy: PrivacyHandler = {
  key: 'assistant',
  tables: [MESSAGES],
  viewPermission: 'assistant.settings.manage',
  async export(subject, conn) {
    const rows = await mentioning(subject, conn).select('created_at', 'role');
    return { messages: rows };
  },
  async erase(subject, trx) {
    const n = await mentioning(subject, trx).delete();
    return { cleared: { messages: n } };
  },
};

function mentioning(subject: { uuid: string; email: string | null }, conn: typeof db) {
  return conn(MESSAGES).where((w) => {
    w.where('content', 'like', `%${subject.uuid}%`);
    if (subject.email) w.orWhere('content', 'like', `%${subject.email.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  });
}

export const assistant: ApiModule = {
  routes: () => [routes],
  migrations: { '0001_assistant': m0001 },
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
