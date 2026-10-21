import type { Request } from 'express';
import type { Scope, VisibilityLevel } from '@app/shared';

export interface AuthUser {
  id: number;
  uuid: string;
  email: string;
  firstName: string;
  lastName: string;
  roleKeys: string[];
  isAdmin: boolean;
  permissions: string[];
  scopes: Record<string, Scope>;
  sessionId: number | null;
  /** Set when the request authenticated with an API key instead of a session. */
  apiKeyId?: number;
  /** Admin who must enrol in 2FA (workspace policy) before using anything else. */
  mfaSetupRequired?: boolean;
}

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  user: AuthUser | null;
}

/** Context for code that runs outside a request (CLI, jobs, blueprint install). */
export const systemContext = (requestId = 'system'): RequestContext => ({
  requestId,
  ip: null,
  userAgent: null,
  user: null,
});

declare module 'express-serve-static-core' {
  interface Request {
    ctx: RequestContext;
  }
}

export function requireUser(req: Request): AuthUser {
  if (!req.ctx.user) throw new Error('requireUser called on unauthenticated request');
  return req.ctx.user;
}

export type FieldAccessMap = Record<string, VisibilityLevel>;
