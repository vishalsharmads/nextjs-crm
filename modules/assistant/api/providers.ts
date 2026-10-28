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

async function chatCompletionsApi(cfg: ProviderConfig, req: ChatRequest): Promise<ChatResult> {
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
