import { z, ZodError } from 'zod';
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { entityKeySchema } from '@app/shared';
import { defineRoutes } from '../../http/routes';
import type { AuthUser, RequestContext } from '../../http/context';
import { AppError } from '../../lib/errors';
import { isTest } from '../../config/env';
import { getBranding, getGroup } from '../settings/settings.service';
import { availableTools, callTool, inputJsonSchema, type ToolContext } from '../tools/registry';
import '../tools/core-tools';
import { wwwAuthenticate } from '../oauth/oauth';

/** MCP protocol versions this server speaks, newest first. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const rpcSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().max(100),
  params: z.record(z.string(), z.unknown()).optional(),
});

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls per person (or per API key) per minute, from Settings → AI clients. */
const limiter = rateLimit({
  windowMs: 60_000,
  limit: async () => (isTest ? 100_000 : (await getGroup('mcp')).rateLimitPerMinute),
  keyGenerator: (req: Request) => {
    const u = req.ctx.user;
    // Per person, not per token, so creating more tokens does not raise the limit.
    return u?.apiKeyId ? `k${u.apiKeyId}` : `u${u?.id ?? req.ip}`;
  },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: () => {
    throw new AppError('RATE_LIMITED', 'Too many requests. Wait a minute and try again.');
  },
});

/** Only when an admin has turned MCP on; checked before the rate limiter counts the call. */
async function requireEnabled(_req: Request, _res: Response, next: (err?: unknown) => void) {
  try {
    if (!(await getGroup('mcp')).enabled) throw new AppError('NOT_FOUND', 'AI client access is turned off');
    next();
  } catch (err) {
    next(err);
  }
}

const RECORD_URI = /^crm:\/\/record\/([a-z][a-z0-9_]{1,31})\/([0-9a-f-]{36})$/;

async function handle(method: string, params: Record<string, unknown>, tc: ToolContext) {
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion ?? '');
      const { appName } = await getBranding();
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: appName, version: '1.0.0' },
        instructions: `Tools act as ${tc.user.firstName} ${tc.user.lastName} in ${appName}, with their permissions. Call describe_schema first. Confirm with the person before calling tools that change data.`,
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return {
        tools: (await availableTools(tc.user)).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: inputJsonSchema(t),
          annotations: { title: t.title, readOnlyHint: !t.write, destructiveHint: false },
        })),
      };
    case 'tools/call': {
      const name = String(params.name ?? '');
      const pool = await availableTools(tc.user);
      if (!pool.some((t) => t.name === name)) throw new RpcError(-32602, `Unknown tool: ${name}`);
      try {
        const result = await callTool(name, params.arguments, tc, pool);
        const structured =
          result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
        return {
          content: [{ type: 'text', text: JSON.stringify(structured) }],
          structuredContent: structured,
        };
      } catch (err) {
        // Tool failures go back to the model as results it can read and correct, not protocol errors.
        const toolErr =
          err instanceof ZodError
            ? new AppError(
                'VALIDATION_FAILED',
                'The input is not valid',
                err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
              )
            : err;
        if (toolErr instanceof AppError)
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  error: toolErr.code,
                  message: toolErr.message,
                  details: toolErr.details,
                }),
              },
            ],
          };
        throw err;
      }
    }
    case 'resources/list':
      return {
        resources: [
          {
            uri: 'crm://schema',
            name: 'schema',
            title: 'Record types and fields',
            mimeType: 'application/json',
          },
        ],
      };
    case 'resources/templates/list':
      return {
        resourceTemplates: [
          {
            uriTemplate: 'crm://record/{entity}/{uuid}',
            name: 'record',
            title: 'One record',
            mimeType: 'application/json',
          },
        ],
      };
    case 'resources/read': {
      const uri = String(params.uri ?? '');
      const pool = await availableTools(tc.user);
      const read = async (tool: string, args: unknown) => {
        if (!pool.some((t) => t.name === tool)) throw new RpcError(-32002, 'Resource not available');
        return callTool(tool, args, tc, pool);
      };
      let value: unknown;
      if (uri === 'crm://schema') value = await read('describe_schema', {});
      else {
        const m = RECORD_URI.exec(uri);
        if (!m || !entityKeySchema.safeParse(m[1]).success) throw new RpcError(-32002, 'Resource not found');
        value = await read('get_record', { entity: m[1], uuid: m[2] });
      }
      return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
    }
    default:
      throw new RpcError(-32601, `Method not found: ${method}`);
  }
}

/**
 * MCP over Streamable HTTP (JSON responses, no server-sent events). Each call runs as the token's
 * user through the tool layer; audit rows are tagged `mcp`.
 */
export const mcpRoutes = defineRoutes('/mcp', ['mcp'])
  .add({
    method: 'post',
    path: '/',
    // Checked below, so an unauthenticated client learns where to sign in (WWW-Authenticate).
    permission: 'public',
    before: [requireEnabled, limiter],
    summary: 'MCP endpoint for AI clients (JSON-RPC 2.0)',
    body: z.unknown(),
    handler: async ({ req, res, ctx, user, body }) => {
      if (!user) {
        res
          .status(401)
          .set('WWW-Authenticate', wwwAuthenticate())
          .json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } });
        return;
      }
      const parsed = rpcSchema.safeParse(body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
        return;
      }
      const { id, method, params } = parsed.data;
      // Notifications (no id) get no response body.
      if (id === undefined || id === null) {
        res.status(202).end();
        return;
      }
      const mcpUser: AuthUser = { ...user, via: 'mcp' };
      const mcpCtx: RequestContext = { ...ctx, user: mcpUser };
      req.ctx = mcpCtx;
      try {
        const result = await handle(method, params ?? {}, { ctx: mcpCtx, user: mcpUser });
        res.json({ jsonrpc: '2.0', id, result });
      } catch (err) {
        if (err instanceof RpcError) {
          res.json({ jsonrpc: '2.0', id, error: { code: err.code, message: err.message } });
          return;
        }
        if (err instanceof AppError) {
          res.json({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: err.message, data: { code: err.code } },
          });
          return;
        }
        throw err;
      }
    },
  })
  .add({
    method: 'get',
    path: '/',
    permission: 'authenticated',
    summary: 'Server-sent events are not offered; clients use POST',
    handler: ({ res }) => {
      res.set('Allow', 'POST').status(405).end();
    },
  });
