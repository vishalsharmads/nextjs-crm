import { AppError, assertSafeUrl, logger } from '@app/api/module-api';
import { simulate } from './simulated';

/** The provider's own error goes to the server log only (it can name the provider); people see ours. */
function logRefusal(status: number, body: string) {
  logger.warn({ status, body: body.slice(0, 1000) }, 'AI provider refused the request');
}

/** What people see when the provider says no. Its own message can name it, so it stays in the log. */
function refusal(status: number) {
  if (status === 401 || status === 403)
    return new AppError(
      'UPSTREAM_FAILED',
      'The AI provider rejected the API key. An admin can check the assistant settings.',
    );
  if (status === 429)
    return new AppError(
      'UPSTREAM_FAILED',
      "The AI provider is busy or this model's limit is used up. Wait a minute and try again, or an admin can pick another model.",
    );
  return new AppError(
    'UPSTREAM_FAILED',
    `The AI provider returned ${status}. An admin can check the assistant settings.`,
  );
}

/** Retries a request the provider turned away for being busy (429, 503), waiting as it asks, briefly. */
const RETRY_WAITS_MS = [1_500, 4_000];
const MAX_RETRY_WAIT_MS = 10_000;

async function withRetry(send: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await send();
    if ((res.status !== 429 && res.status !== 503) || attempt >= RETRY_WAITS_MS.length) return res;
    const after = Number(res.headers.get('retry-after'));
    const wait = Number.isFinite(after) && after > 0 ? after * 1000 : RETRY_WAITS_MS[attempt]!;
    if (wait > MAX_RETRY_WAIT_MS) return res;
    await res.body?.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/**
 * Private addresses the server operator allowed for model servers (`ASSISTANT_PRIVATE_HOSTS`,
 * comma-separated `host:port`, such as `localhost:11434`). Admins cannot add to it.
 */
export function modelHosts(): string[] {
  return (process.env.ASSISTANT_PRIVATE_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter((h) => /^[a-z0-9.-]+:\d{1,5}$|^\[[0-9a-f:]+\]:\d{1,5}$/.test(h));
}

/** Checked on every call too, so a host that later resolves to an internal address is refused. */
export const assertSafeModelUrl = (url: string) =>
  assertSafeUrl(url, 'baseUrl', { privateHosts: modelHosts() });

/** The key, in the header the format expects; none when the server needs no key. */
function authHeaders(cfg: { provider: ProviderKind; apiKey: string }): Record<string, string> {
  if (!cfg.apiKey) return {};
  return cfg.provider === 'messages'
    ? { 'x-api-key': cfg.apiKey }
    : { authorization: `Bearer ${cfg.apiKey}` };
}

/** Content in the conversation, in one shape for every provider. */
export type Block =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /**
       * Opaque data the provider attached to the call (chat completions `extra_content`, such as a
       * reasoning signature) and requires back unchanged with the next request.
       */
      extra?: Record<string, unknown>;
    }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

export interface ToolSpec {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export interface ChatRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
}

export interface ChatResult {
  content: Block[];
  usage: { input: number; output: number };
}

export interface ProviderConfig {
  provider: ProviderKind;
  baseUrl: string;
  model: string;
  apiKey: string;
  headers: Record<string, string>;
}

/**
 * Two wire formats cover the hosted and self-hosted model APIs in use: a "messages" API with
 * native tool-use blocks, and the widely copied "chat completions" API. Names shown to admins are
 * these formats, never a vendor's.
 */
export const WIRE_FORMATS = ['messages', 'chat_completions'] as const;
/** Plus scripted replies for testing (`simulated.ts`), picked from the provider list only. */
export const PROVIDERS = [...WIRE_FORMATS, 'simulated'] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

const TIMEOUT_MS = 60_000;

/** Largest provider response read (bytes). */
const MAX_RESPONSE = 2_000_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  // Checked on every call too, so a host that later resolves to an internal address is refused.
  await assertSafeModelUrl(url);
  const res = await withRetry(async () => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        // Never follow redirects: the key and headers must reach only the configured address.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new AppError('UPSTREAM_FAILED', 'The AI provider could not be reached. Try again in a moment.');
    }
  });
  const text = await res.text();
  if (text.length > MAX_RESPONSE)
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a response that is too large.');
  if (!res.ok) {
    logRefusal(res.status, text);
    throw refusal(res.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a response that could not be read.');
  }
}

/** Models the provider offers, read from its model list. Same address checks as chat calls. */
export async function listModels(cfg: Omit<ProviderConfig, 'model'>): Promise<string[]> {
  const url =
    cfg.provider === 'messages' ? join(cfg.baseUrl, '/v1/models?limit=1000') : join(cfg.baseUrl, '/models');
  await assertSafeModelUrl(url);
  const auth: Record<string, string> = authHeaders(cfg);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { ...cfg.headers, ...auth },
      redirect: 'manual',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The AI provider could not be reached. Check the address.');
  }
  const text = await res.text();
  if (!res.ok || text.length > MAX_RESPONSE)
    throw new AppError(
      'UPSTREAM_FAILED',
      res.status === 401 || res.status === 403
        ? 'The AI provider rejected the API key.'
        : 'The AI provider did not return a model list.',
    );
  let ids: string[] = [];
  try {
    const out = JSON.parse(text) as {
      data?: { id?: unknown }[];
      models?: { id?: unknown; name?: unknown }[];
    };
    ids = (out.data ?? out.models ?? []).map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean);
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a model list that could not be read.');
  }
  // Some providers prefix ids ("models/…"); chat models only, never embeddings, speech or images.
  const NOT_CHAT = /embed|tts|whisper|dall-e|image|audio|moderation|realtime|transcri|rerank|guard|search/i;
  return [...new Set(ids.map((id) => id.replace(/^models\//, '')).filter((id) => !NOT_CHAT.test(id)))]
    .sort()
    .slice(0, 500);
}

/** Keep a provider's per-call data only when it is a small plain object. */
function extraOf(v: unknown): { extra?: Record<string, unknown> } {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return JSON.stringify(v).length <= 20_000 ? { extra: v as Record<string, unknown> } : {};
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

async function messagesApi(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const out = (await post(
    join(cfg.baseUrl, '/v1/messages'),
    { ...cfg.headers, ...authHeaders(cfg) },
    {
      model: cfg.model,
      max_tokens: 2048,
      system: req.system,
      messages: req.messages,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    },
  )) as {
    content?: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const content: Block[] = [];
  for (const b of out.content ?? []) {
    if (b.type === 'text' && b.text) content.push({ type: 'text', text: b.text });
    if (b.type === 'tool_use' && b.id && b.name)
      content.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
  }
  return { content, usage: { input: out.usage?.input_tokens ?? 0, output: out.usage?.output_tokens ?? 0 } };
}

/** The conversation in the chat completions shape (system message, tool calls, tool results). */
function chatMessages(req: ChatRequest): unknown[] {
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  for (const m of req.messages) {
    if (m.role === 'assistant') {
      const text = m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
      const calls = m.content.flatMap((b) =>
        b.type === 'tool_use'
          ? [
              {
                id: b.id,
                type: 'function',
                function: { name: b.name, arguments: JSON.stringify(b.input) },
                ...(b.extra ? { extra_content: b.extra } : {}),
              },
            ]
          : [],
      );
      messages.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      continue;
    }
    for (const b of m.content) {
      if (b.type === 'tool_result')
        messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content });
      if (b.type === 'text') messages.push({ role: 'user', content: b.text });
    }
  }
  return messages;
}

async function chatCompletionsApi(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const messages = chatMessages(req);
  const out = (await post(
    join(cfg.baseUrl, '/chat/completions'),
    { ...cfg.headers, ...authHeaders(cfg) },
    {
      model: cfg.model,
      max_tokens: 2048,
      messages,
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      })),
    },
  )) as {
    choices?: {
      message?: {
        content?: string | null;
        tool_calls?: { id: string; function: { name: string; arguments: string }; extra_content?: unknown }[];
      };
    }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const msg = out.choices?.[0]?.message;
  const content: Block[] = [];
  if (msg?.content) content.push({ type: 'text', text: msg.content });
  for (const c of msg?.tool_calls ?? []) {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
    } catch {
      input = {};
    }
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input, ...extraOf(c.extra_content) });
  }
  return {
    content,
    usage: { input: out.usage?.prompt_tokens ?? 0, output: out.usage?.completion_tokens ?? 0 },
  };
}

export function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  if (cfg.provider === 'simulated') return simulate(req);
  return cfg.provider === 'messages' ? messagesApi(cfg, req) : chatCompletionsApi(cfg, req);
}

/** Called as a reply streams in. */
export interface StreamHandlers {
  text(delta: string): void;
}

/** Read a server-sent event stream as `data:` payloads (with their `event:` names). */
async function* sseEvents(res: Response): AsyncGenerator<{ event: string | null; data: string }> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE) {
      await reader.cancel();
      throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a response that is too large.');
    }
    buffer += decoder.decode(value, { stream: true });
    let cut: number;
    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
      let event: string | null = null;
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}

async function open(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  await assertSafeModelUrl(url);
  const res = await withRetry(async () => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS * 3),
      });
    } catch {
      throw new AppError('UPSTREAM_FAILED', 'The AI provider could not be reached. Try again in a moment.');
    }
  });
  if (!res.ok || !res.body) {
    logRefusal(res.status, await res.text().catch(() => ''));
    throw refusal(res.status);
  }
  return res;
}

const CUT_OFF = "The AI provider's reply was cut off. Try again.";
/** Content blocks or tool calls one reply may hold. */
const MAX_BLOCKS = 32;

/** Tool arguments as sent; half-sent or broken JSON is an error, never an empty input. */
function toolInput(json: string): Record<string, unknown> {
  if (!json.trim()) return {};
  const value = parse(json);
  if (!value)
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent tool input that could not be read.');
  return value;
}

const parse = (s: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
};

async function messagesStream(
  cfg: ProviderConfig,
  req: ChatRequest,
  on: StreamHandlers,
): Promise<ChatResult> {
  const res = await open(
    join(cfg.baseUrl, '/v1/messages'),
    { ...cfg.headers, ...authHeaders(cfg) },
    {
      model: cfg.model,
      max_tokens: 2048,
      stream: true,
      system: req.system,
      messages: req.messages,
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.schema })),
    },
  );
  const blocks: (
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; json: string }
  )[] = [];
  const usage = { input: 0, output: 0 };
  let finished = false;
  for await (const { data } of sseEvents(res)) {
    const e = parse(data);
    if (!e) continue;
    const index = Number(e.index ?? -1);
    if (e.type === 'message_stop') finished = true;
    if (e.type?.toString().startsWith('content_block') && !(index >= 0 && index < MAX_BLOCKS))
      throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a reply that could not be read.');
    if (e.type === 'message_start') {
      const u = (e.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      usage.input = u?.input_tokens ?? 0;
    } else if (e.type === 'content_block_start') {
      const b = e.content_block as { type: string; id?: string; name?: string };
      blocks[index] =
        b.type === 'tool_use'
          ? { type: 'tool_use', id: b.id ?? '', name: b.name ?? '', json: '' }
          : { type: 'text', text: '' };
    } else if (e.type === 'content_block_delta') {
      const d = e.delta as { type: string; text?: string; partial_json?: string };
      const b = blocks[index];
      if (b?.type === 'text' && d.text) {
        b.text += d.text;
        on.text(d.text);
      } else if (b?.type === 'tool_use' && d.partial_json) b.json += d.partial_json;
    } else if (e.type === 'message_delta') {
      usage.output = (e.usage as { output_tokens?: number } | undefined)?.output_tokens ?? usage.output;
    } else if (e.type === 'error') {
      throw new AppError('UPSTREAM_FAILED', 'The AI provider stopped with an error. Try again.');
    }
  }
  if (!finished) throw new AppError('UPSTREAM_FAILED', CUT_OFF);
  const content: Block[] = blocks.flatMap((b): Block[] => {
    if (!b) return [];
    if (b.type === 'text') return b.text ? [{ type: 'text', text: b.text }] : [];
    return [{ type: 'tool_use', id: b.id, name: b.name, input: toolInput(b.json) }];
  });
  return { content, usage };
}

async function chatCompletionsStream(
  cfg: ProviderConfig,
  req: ChatRequest,
  on: StreamHandlers,
): Promise<ChatResult> {
  const res = await open(
    join(cfg.baseUrl, '/chat/completions'),
    { ...cfg.headers, ...authHeaders(cfg) },
    {
      model: cfg.model,
      max_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
      messages: chatMessages(req),
      tools: req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      })),
    },
  );
  let text = '';
  const calls: { id: string; name: string; args: string; extra?: unknown }[] = [];
  const usage = { input: 0, output: 0 };
  let finished = false;
  for await (const { data } of sseEvents(res)) {
    if (data === '[DONE]') {
      finished = true;
      break;
    }
    const e = parse(data) as {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: {
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
            extra_content?: unknown;
          }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    if (!e) continue;
    if ((e as { error?: unknown }).error)
      throw new AppError('UPSTREAM_FAILED', 'The AI provider stopped with an error. Try again.');
    if ((e.choices?.[0] as { finish_reason?: string | null } | undefined)?.finish_reason) finished = true;
    if (e.usage) {
      usage.input = e.usage.prompt_tokens ?? 0;
      usage.output = e.usage.completion_tokens ?? 0;
    }
    const delta = e.choices?.[0]?.delta;
    if (delta?.content) {
      text += delta.content;
      on.text(delta.content);
    }
    for (const c of delta?.tool_calls ?? []) {
      if (!(c.index >= 0 && c.index < MAX_BLOCKS))
        throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a reply that could not be read.');
      const call = (calls[c.index] ??= { id: '', name: '', args: '' });
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      if (c.function?.arguments) call.args += c.function.arguments;
      if (c.extra_content) call.extra = c.extra_content;
    }
  }
  if (!finished) throw new AppError('UPSTREAM_FAILED', CUT_OFF);
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls)
    if (c)
      content.push({
        type: 'tool_use',
        id: c.id,
        name: c.name,
        input: toolInput(c.args),
        ...extraOf(c.extra),
      });
  return { content, usage };
}

/** Like `chat`, but text arrives through `on.text` as the provider produces it. */
export function chatStream(cfg: ProviderConfig, req: ChatRequest, on: StreamHandlers): Promise<ChatResult> {
  if (cfg.provider === 'simulated') return simulate(req, on);
  return cfg.provider === 'messages' ? messagesStream(cfg, req, on) : chatCompletionsStream(cfg, req, on);
}
