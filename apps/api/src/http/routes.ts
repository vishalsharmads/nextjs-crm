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

function toHandler(def: RouteDef): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (def.moduleKey && !moduleGate(def.moduleKey)) {
        throw new AppError('MODULE_DISABLED', 'This feature is not enabled');
      }
      const user = checkPermission(req.ctx.user, def.permission, res.locals.tokenExpired === true);
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
      router[def.method](def.path, ...(def.before ?? []), toHandler(def));
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
