import type { Request, Response } from 'express';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { cookieSecure, env } from '../../config/env';
import { sha256, randomToken } from '../../lib/crypto';
import { newUuid } from '../../lib/ids';
import { db, type Db } from '../../db/knex';

export const ACCESS_COOKIE = 'access_token';
export const REFRESH_COOKIE = 'refresh_token';
export const MFA_COOKIE = 'mfa_token';
const REFRESH_PATH = '/api/v1/auth';

const secret = () => new TextEncoder().encode(env.JWT_SECRET);

export interface AccessClaims {
  uid: number;
  sid: number;
}

export async function signAccessToken(claims: AccessClaims, userUuid: string): Promise<string> {
  return new SignJWT({ uid: claims.uid, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userUuid)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_MIN}m`)
    .sign(secret());
}

export type VerifyResult = { ok: true; claims: AccessClaims } | { ok: false; expired: boolean };

export async function verifyAccessToken(token: string): Promise<VerifyResult> {
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ['HS256'] });
    if (typeof payload.uid !== 'number' || typeof payload.sid !== 'number')
      return { ok: false, expired: false };
    return { ok: true, claims: { uid: payload.uid, sid: payload.sid } };
  } catch (err) {
    return { ok: false, expired: err instanceof joseErrors.JWTExpired };
  }
}

const baseCookie = { httpOnly: true, secure: cookieSecure } as const;

export function setAuthCookies(res: Response, access: string, refresh: string) {
  res.cookie(ACCESS_COOKIE, access, {
    ...baseCookie,
    sameSite: 'lax',
    path: '/api',
    maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000,
  });
  res.cookie(REFRESH_COOKIE, refresh, {
    ...baseCookie,
    sameSite: 'strict',
    path: REFRESH_PATH,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  });
}

export function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...baseCookie, path: '/api' });
  res.clearCookie(REFRESH_COOKIE, { ...baseCookie, path: REFRESH_PATH });
  res.clearCookie(MFA_COOKIE, { ...baseCookie, path: REFRESH_PATH });
}

export function setMfaCookie(res: Response, token: string) {
  res.cookie(MFA_COOKIE, token, {
    ...baseCookie,
    sameSite: 'strict',
    path: REFRESH_PATH,
    maxAge: 5 * 60_000,
  });
}

/** What a rotated session carries over from the row it replaces. */
export interface SessionCarry {
  familyId: string;
  familyStartedAt: Date;
  /** Last user activity, so a background refresh does not count as activity. */
  lastUsedAt: Date;
}

/** Create a session (refresh-token family member) and set cookies. */
export async function startSession(
  conn: Db,
  res: Response,
  req: Request,
  user: { id: number; uuid: string },
  carry?: SessionCarry,
): Promise<number> {
  const refresh = randomToken(32);
  const now = new Date();
  const [sessionId] = await conn('sessions').insert({
    uuid: newUuid(),
    user_id: user.id,
    refresh_hash: sha256(refresh),
    family_id: carry?.familyId ?? newUuid(),
    family_started_at: carry?.familyStartedAt ?? now,
    last_used_at: carry?.lastUsedAt ?? now,
    user_agent: req.get('user-agent')?.slice(0, 500) ?? null,
    ip: req.ip ?? null,
    expires_at: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  const access = await signAccessToken({ uid: user.id, sid: sessionId! }, user.uuid);
  setAuthCookies(res, access, refresh);
  return sessionId!;
}

export async function revokeFamily(familyId: string, conn: Db = db) {
  await conn('sessions')
    .where({ family_id: familyId })
    .whereNull('revoked_at')
    .update({ revoked_at: new Date() });
}

/** One-time tokens (reset, invite, mfa). Only the hash is stored. */
export async function createOneTimeToken(
  conn: Db,
  userId: number,
  purpose: 'reset' | 'invite' | 'mfa',
  ttlMinutes: number,
): Promise<string> {
  const token = randomToken(32);
  await conn('auth_tokens')
    .where({ user_id: userId, purpose })
    .whereNull('used_at')
    .update({ used_at: new Date() });
  await conn('auth_tokens').insert({
    user_id: userId,
    purpose,
    token_hash: sha256(token),
    expires_at: new Date(Date.now() + ttlMinutes * 60_000),
  });
  return token;
}

/** Atomically consume a one-time token: exactly one concurrent caller can succeed. */
export async function consumeOneTimeToken(
  conn: Db,
  token: string,
  purpose: 'reset' | 'invite' | 'mfa',
): Promise<number | null> {
  const hash = sha256(token);
  const row = await conn('auth_tokens').where({ token_hash: hash, purpose }).first('user_id');
  if (!row) return null;
  const affected = await conn('auth_tokens')
    .where({ token_hash: hash, purpose })
    .whereNull('used_at')
    .where('expires_at', '>', new Date())
    .update({ used_at: new Date() });
  return affected === 1 ? (row.user_id as number) : null;
}

/** Invalidate every unused one-time token for a user (on disable, password change). */
export async function burnUserTokens(conn: Db, userId: number) {
  await conn('auth_tokens').where({ user_id: userId }).whereNull('used_at').update({ used_at: new Date() });
}
