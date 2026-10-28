import { AppError, assertSafeUrl } from '@app/api/module-api';

/** Content in the conversation, in one shape for every provider. */
export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
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
export const PROVIDERS = ['messages', 'chat_completions'] as const;
export type ProviderKind = (typeof PROVIDERS)[number];

const TIMEOUT_MS = 60_000;

/** Largest provider response read (bytes). */
const MAX_RESPONSE = 2_000_000;

async function post(url: string, headers: Record<string, string>, body: unknown): Promise<unknown> {
  // Checked on every call too, so a host that later resolves to an internal address is refused.
  await assertSafeUrl(url, 'baseUrl');
  let res: Response;
  try {
    res = await fetch(url, {
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
  const text = await res.text();
  if (text.length > MAX_RESPONSE)
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a response that is too large.');
  if (!res.ok) {
    // The provider's own message can name the provider: keep it out of what people see.
    const status =
      res.status === 401 || res.status === 403 ? 'rejected the API key' : `returned ${res.status}`;
    throw new AppError(
      'UPSTREAM_FAILED',
      `The AI provider ${status}. An admin can check the assistant settings.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The AI provider sent a response that could not be read.');
  }
}

const join = (base: string, path: string) => `${base.replace(/\/+$/, '')}${path}`;

async function messagesApi(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
  const out = (await post(
    join(cfg.baseUrl, '/v1/messages'),
    { ...cfg.headers, 'x-api-key': cfg.apiKey },
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
          ? [{ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } }]
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
    { ...cfg.headers, authorization: `Bearer ${cfg.apiKey}` },
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
        tool_calls?: { id: string; function: { name: string; arguments: string } }[];
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
    content.push({ type: 'tool_use', id: c.id, name: c.function.name, input });
  }
  return {
    content,
    usage: { input: out.usage?.prompt_tokens ?? 0, output: out.usage?.completion_tokens ?? 0 },
  };
}

export function chat(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
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
  await assertSafeUrl(url, 'baseUrl');
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS * 3),
    });
  } catch {
    throw new AppError('UPSTREAM_FAILED', 'The AI provider could not be reached. Try again in a moment.');
  }
  if (!res.ok || !res.body) {
    const status =
      res.status === 401 || res.status === 403 ? 'rejected the API key' : `returned ${res.status}`;
    throw new AppError(
      'UPSTREAM_FAILED',
      `The AI provider ${status}. An admin can check the assistant settings.`,
    );
  }
  return res;
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
    { ...cfg.headers, 'x-api-key': cfg.apiKey },
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
  for await (const { data } of sseEvents(res)) {
    const e = parse(data);
    if (!e) continue;
    const index = Number(e.index ?? -1);
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
  const content: Block[] = blocks.flatMap((b): Block[] => {
    if (!b) return [];
    if (b.type === 'text') return b.text ? [{ type: 'text', text: b.text }] : [];
    return [{ type: 'tool_use', id: b.id, name: b.name, input: parse(b.json || '{}') ?? {} }];
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
    { ...cfg.headers, authorization: `Bearer ${cfg.apiKey}` },
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
  const calls: { id: string; name: string; args: string }[] = [];
  const usage = { input: 0, output: 0 };
  for await (const { data } of sseEvents(res)) {
    if (data === '[DONE]') break;
    const e = parse(data) as {
      choices?: {
        delta?: {
          content?: string | null;
          tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
        };
      }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    } | null;
    if (!e) continue;
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
      const call = (calls[c.index] ??= { id: '', name: '', args: '' });
      if (c.id) call.id = c.id;
      if (c.function?.name) call.name += c.function.name;
      if (c.function?.arguments) call.args += c.function.arguments;
    }
  }
  const content: Block[] = [];
  if (text) content.push({ type: 'text', text });
  for (const c of calls)
    if (c) content.push({ type: 'tool_use', id: c.id, name: c.name, input: parse(c.args || '{}') ?? {} });
  return { content, usage };
}

/** Like `chat`, but text arrives through `on.text` as the provider produces it. */
export function chatStream(cfg: ProviderConfig, req: ChatRequest, on: StreamHandlers): Promise<ChatResult> {
  return cfg.provider === 'messages' ? messagesStream(cfg, req, on) : chatCompletionsStream(cfg, req, on);
}
