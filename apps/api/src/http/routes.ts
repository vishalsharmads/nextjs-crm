import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { Router } from 'express';
import type { z } from 'zod';
import { hasPermission } from '@app/shared';
import { AppError } from '../lib/errors';
import type { AuthUser, RequestContext } from './context';

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/** Every route declares its access requirement. There is no default. */
export type RoutePermission = 'public' | 'authenticated' | (string & {});

export interface RouteInput<P, Q, B> {
  params: P;
  query: Q;
  body: B;
}

export interface HandlerArgs<P, Q, B> extends RouteInput<P, Q, B> {
  req: Request;
  res: Response;
  ctx: RequestContext;
  user: AuthUser;
}

export interface RouteDef<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  B extends z.ZodType = z.ZodType,
> {
  method: HttpMethod;
  path: string;
  permission: RoutePermission;
  summary?: string;
  tags?: string[];
  params?: P;
  query?: Q;
  body?: B;
  status?: number;
  /** Extra middleware run before validation (rate limiters, upload parsers). */
  before?: RequestHandler[];
  /** Module that owns this route; requests 404 when the module is disabled. */
  moduleKey?: string;
  handler: (args: HandlerArgs<z.output<P>, z.output<Q>, z.output<B>>) => unknown;
}

export interface RegisteredRoute {
  method: HttpMethod;
  path: string;
  permission: RoutePermission;
  summary?: string;
  tags?: string[];
  moduleKey?: string;
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

/** Global registry: the route-permission test asserts every Express route is in here. */
export const routeRegistry: RegisteredRoute[] = [];

/** Mounted routes with their handlers, in mount order, for `callRoute`. */
const mounted: RouteDef[] = [];

export type ModuleGate = (moduleKey: string) => boolean;
let moduleGate: ModuleGate = () => true;
export const setModuleGate = (gate: ModuleGate) => {
  moduleGate = gate;
};

export function checkPermission(
  user: AuthUser | null,
  permission: RoutePermission,
  tokenExpired = false,
): AuthUser | null {
  if (permission === 'public') return user;
  if (!user) {
    throw tokenExpired
      ? new AppError('TOKEN_EXPIRED', 'Your session expired')
      : new AppError('UNAUTHENTICATED', 'Sign in to continue');
  }
  if (permission === 'authenticated') return user;
  if (user.readOnly && !permission.endsWith('.view'))
    throw new AppError('FORBIDDEN', 'This access token is read-only');
  if (!user.isAdmin && !hasPermission(user.permissions, permission)) {
    throw new AppError('FORBIDDEN', 'You do not have permission to do that');
  }
  return user;
}

/** Routes are declared in feature files and mounted flat on one router (keeps paths introspectable). */
export class RouteGroup {
  readonly defs: RouteDef[] = [];
  constructor(
    readonly prefix: string,
    readonly tags: string[] = [],
    readonly moduleKey?: string,
  ) {}

  add<P extends z.ZodType, Q extends z.ZodType, B extends z.ZodType>(def: RouteDef<P, Q, B>) {
    this.defs.push({
      ...def,
      path: joinPath(this.prefix, def.path),
      tags: def.tags ?? this.tags,
      moduleKey: def.moduleKey ?? this.moduleKey,
    } as unknown as RouteDef);
    return this;
  }
}

function joinPath(prefix: string, path: string) {
  const p = `${prefix}/${path}`.replace(/\/+/g, '/');
  return p.length > 1 ? p.replace(/\/$/, '') : p;
}

export function defineRoutes(prefix: string, tags: string[] = [], moduleKey?: string) {
  return new RouteGroup(prefix, tags, moduleKey);
}

/** Paths an admin who must enrol in 2FA can still reach. */
const MFA_SETUP_ALLOWED = [/^\/auth\//, /^\/me(\/|$)/, /^\/meta\/bootstrap$/, /^\/public\//];

/**
 * Access gate: runs before any `before` middleware (so uploads are never parsed for callers
 * who are not allowed), checks module state, permission, and enforced 2FA enrolment.
 */
function gate(def: RouteDef): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      if (def.moduleKey && !moduleGate(def.moduleKey)) {
        throw new AppError('MODULE_DISABLED', 'This feature is not enabled');
      }
      const user = checkPermission(req.ctx.user, def.permission, res.locals.tokenExpired === true);
      if (user?.mfaSetupRequired && !MFA_SETUP_ALLOWED.some((re) => re.test(def.path))) {
        throw new AppError('MFA_REQUIRED', 'Turn on two-factor authentication to continue');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

function toHandler(def: RouteDef): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = req.ctx.user;
      const params = def.params ? def.params.parse(req.params) : req.params;
      const query = def.query ? def.query.parse(req.query) : req.query;
      const body = def.body ? def.body.parse(req.body ?? {}) : req.body;
      const result = await def.handler({
        req,
        res,
        ctx: req.ctx,
        user: user as AuthUser,
        params,
        query,
        body,
      });
      await logModuleRead(def, req, params);
      if (res.headersSent) return;
      if (result === undefined) {
        res.status(def.status ?? 204).end();
      } else {
        res.status(def.status ?? 200).json(result);
      }
    } catch (err) {
      next(err);
    }
  };
}

export function mountGroups(router: Router, groups: RouteGroup[]) {
  for (const group of groups) {
    for (const def of group.defs) {
      router[def.method](def.path, gate(def), ...(def.before ?? []), toHandler(def));
      mounted.push(def);
      routeRegistry.push({
        method: def.method,
        path: def.path,
        permission: def.permission,
        summary: def.summary,
        tags: def.tags,
        moduleKey: def.moduleKey,
        params: def.params,
        query: def.query,
        body: def.body,
      });
    }
  }
}

export function createApiRouter() {
  return Router();
}

/**
 * Module records are read through module routes, which core services never see. A successful
 * GET of one record (`/:uuid`, guarded by a `.view` permission) goes to the access log, named by
 * the permission's resource (for example `tickets.tickets`). Core record reads log in their services.
 */
async function logModuleRead(def: RouteDef, req: Request, params: unknown) {
  const uuid = (params as { uuid?: unknown } | null)?.uuid;
  if (!def.moduleKey || def.method !== 'get' || typeof uuid !== 'string') return;
  if (typeof def.permission !== 'string' || !def.permission.endsWith('.view')) return;
  const { logAccess } = await import('../core/audit/access-log');
  await logAccess(req.ctx, {
    action: 'view',
    entity: def.permission.slice(0, -'.view'.length),
    entityUuid: uuid,
  });
}

/** Matches `/pipelines/:uuid` against `/pipelines/0190…`, returning the params. */
function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/');
  const got = path.split('/');
  if (want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(':')) {
      if (!got[i]) return null;
      params[want[i]!.slice(1)] = decodeURIComponent(got[i]!);
    } else if (want[i] !== got[i]) return null;
  }
  return params;
}

/** The mounted route a request would reach (static paths win, as in Express: mount order). */
export function findRoute(
  method: HttpMethod,
  path: string,
): { def: RouteDef; params: Record<string, string> } | null {
  for (const def of mounted) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, path);
    if (params) return { def, params };
  }
  return null;
}

/**
 * Runs a JSON route in-process as `user`, exactly as a request would: module state, permission,
 * required 2FA, Zod validation, then the route's own handler (with its business rules and audit).
 * Routes with their own middleware (uploads, rate limits) and routes that stream or send files are
 * refused. For callers that act for a person inside the app, such as the assistant.
 */
export async function callRoute(
  method: HttpMethod,
  path: string,
  input: { query?: Record<string, unknown>; body?: unknown },
  { user, ctx }: { user: AuthUser; ctx: RequestContext },
): Promise<unknown> {
  const found = findRoute(method, path);
  if (!found) throw new AppError('NOT_FOUND', `There is no ${method.toUpperCase()} ${path}`);
  const { def } = found;
  if (def.before?.length) throw new AppError('FORBIDDEN', 'This action is not available here');
  if (def.moduleKey && !moduleGate(def.moduleKey))
    throw new AppError('MODULE_DISABLED', 'This feature is not enabled');
  checkPermission(user, def.permission);
  if (user.mfaSetupRequired && !MFA_SETUP_ALLOWED.some((re) => re.test(def.path)))
    throw new AppError('MFA_REQUIRED', 'Turn on two-factor authentication to continue');
  const params = def.params ? def.params.parse(found.params) : found.params;
  const query = def.query ? def.query.parse(input.query ?? {}) : (input.query ?? {});
  const body = def.body ? def.body.parse(input.body ?? {}) : input.body;
  const refuse = () => {
    throw new AppError('FORBIDDEN', 'This action is not available here');
  };
  // Header calls are harmless; anything that writes a raw response is not supported in-process.
  const res = {
    headersSent: false,
    locals: {},
    set: () => res,
    setHeader: () => res,
    type: () => res,
    status: () => res,
    send: refuse,
    json: refuse,
    end: refuse,
    write: refuse,
    pipe: refuse,
  };
  const req = { ctx, params, query, body, headers: {}, method: method.toUpperCase(), path };
  return def.handler({
    req: req as unknown as Request,
    res: res as unknown as Response,
    ctx,
    user,
    params,
    query,
    body,
  });
}
