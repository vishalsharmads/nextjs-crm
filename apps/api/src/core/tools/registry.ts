import { z } from 'zod';
import type { ToolInfo } from '@app/shared';
import type { AuthUser, RequestContext } from '../../http/context';
import { AppError } from '../../lib/errors';
import { getGroup } from '../settings/settings.service';

export interface ToolContext {
  ctx: RequestContext;
  user: AuthUser;
}

/**
 * A capability offered to AI clients (MCP) and the in-app assistant. Handlers call the service
 * layer as the signed-in user, so permissions, record scope, field visibility, access logging and
 * audit apply exactly as in the app. Never query tables directly from a tool.
 */
export interface ToolDef<I extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  /** Changes data. Hidden from read-only tokens; the assistant asks before running it. */
  write: boolean;
  input: I;
  handler(input: z.output<I>, tc: ToolContext): Promise<unknown>;
}

const tools = new Map<string, ToolDef>();

export function defineTool<I extends z.ZodType>(def: ToolDef<I>): ToolDef<I> {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(def.name)) throw new Error(`Invalid tool name "${def.name}"`);
  if (tools.has(def.name)) throw new Error(`Tool "${def.name}" is already registered`);
  tools.set(def.name, def as unknown as ToolDef);
  return def;
}

/** Every registered tool (admins choose from these in Settings → AI clients). */
export function allTools(): ToolInfo[] {
  return [...tools.values()].map(({ name, title, description, write }) => ({
    name,
    title,
    description,
    write,
  }));
}

/** Tools this user may call through MCP: allowed by the admin list, and read-only for read tokens. */
export async function availableTools(user: AuthUser): Promise<ToolDef[]> {
  const { tools: allowed } = await getGroup('mcp');
  return [...tools.values()].filter(
    (t) => (!allowed.length || allowed.includes(t.name)) && (!t.write || !user.readOnly),
  );
}

export function inputJsonSchema(tool: ToolDef) {
  return z.toJSONSchema(tool.input, { io: 'input', unrepresentable: 'any' });
}

/** Validate and run one tool. Unknown or disallowed tools are a 404, bad input a 422. */
export async function callTool(name: string, args: unknown, tc: ToolContext, pool?: ToolDef[]) {
  const tool = (pool ?? [...tools.values()]).find((t) => t.name === name);
  if (!tool) throw new AppError('NOT_FOUND', `Unknown tool "${name}"`);
  if (tool.write && tc.user.readOnly) throw new AppError('FORBIDDEN', 'This access token is read-only');
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success)
    throw new AppError(
      'VALIDATION_FAILED',
      'The tool input is not valid',
      parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  return tool.handler(parsed.data, tc);
}
