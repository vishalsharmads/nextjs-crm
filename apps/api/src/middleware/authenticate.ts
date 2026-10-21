import type { NextFunction, Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ACCESS_COOKIE, verifyAccessToken } from '../core/auth/tokens';
import { loadAccess } from '../core/rbac/access';
import { db } from '../db/knex';
import { authenticateApiKey } from '../core/api-keys/api-keys';
import { getGroup } from '../core/settings/settings.service';

/** Attach request context. Never rejects; route permission checks decide what is allowed. */
export async function contextMiddleware(req: Request, _res: Response, next: NextFunction) {
  req.ctx = {
    requestId: (req.get('x-request-id') ?? randomUUID()).slice(0, 64),
    ip: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    user: null,
  };
  next();
}

export async function authenticate(req: Request, res: Response, next: NextFunction) {
  try {
    const bearer = req.get('authorization');
    if (bearer?.startsWith('Bearer ')) {
      req.ctx.user = await authenticateApiKey(bearer.slice(7).trim());
      return next();
    }
    const token = req.cookies?.[ACCESS_COOKIE] as string | undefined;
    if (!token) return next();
    const result = await verifyAccessToken(token);
    if (!result.ok) {
      if (result.expired) res.locals.tokenExpired = true;
      return next();
    }
    const row = await db('users as u')
      .join('sessions as s', 's.user_id', 'u.id')
      .where('u.id', result.claims.uid)
      .where('s.id', result.claims.sid)
      .whereNull('s.revoked_at')
      .whereNull('u.deleted_at')
      .where('u.status', 'active')
      .first('u.id', 'u.uuid', 'u.email', 'u.first_name', 'u.last_name', 'u.totp_enabled');
    if (!row) return next();
    const access = await loadAccess(row.id as number);
    req.ctx.user = {
      id: row.id,
      uuid: row.uuid,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      sessionId: result.claims.sid,
      ...access,
    };
    if (access.isAdmin && !row.totp_enabled) {
      const security = await getGroup('security');
      if (security.totpRequiredForAdmins && security.totpAllowed) req.ctx.user.mfaSetupRequired = true;
    }
    next();
  } catch (err) {
    next(err);
  }
}
