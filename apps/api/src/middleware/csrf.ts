import type { NextFunction, Request, Response } from 'express';
import { env, cookieSecure } from '../config/env';
import { AppError } from '../lib/errors';
import { hmac, randomToken, safeEqual } from '../lib/crypto';

export const CSRF_COOKIE = 'csrf_token';
export const CSRF_HEADER = 'x-csrf-token';

/** Signed double-submit token: `<nonce>.<hmac(nonce)>`. */
export function issueCsrfToken(res: Response): string {
  const nonce = randomToken(24);
  const token = `${nonce}.${hmac(env.CSRF_SECRET, nonce)}`;
  res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', secure: cookieSecure, path: '/' });
  return token;
}

function validToken(token: string) {
  const [nonce, sig] = token.split('.');
  return !!nonce && !!sig && safeEqual(sig, hmac(env.CSRF_SECRET, nonce));
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const PUBLIC_FORM_SUBMIT = /^\/api\/v1\/public\/forms\/[0-9a-f-]{36}\/submit$/;
// One-click unsubscribe (RFC 8058) is posted by mail clients; a signed token authorizes it.
const PUBLIC_UNSUBSCRIBE = /^\/api\/v1\/public\/privacy\/unsubscribe$/;
// OAuth client endpoints are called by AI clients, not browsers with a session (PKCE protects codes).
const OAUTH_CLIENT = /^\/api\/v1\/oauth\/(register|token|revoke)$/;
// Booking a meeting (and cancelling it with the emailed link) is done by visitors without a session.
const PUBLIC_BOOKING =
  /^\/api\/v1\/public\/book\/([a-z0-9][a-z0-9-]{2,59}|manage\/[A-Za-z0-9_-]{43}\/cancel)$/;

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  // Bearer-token clients (API keys) are not cookie-authenticated, so CSRF does not apply —
  // but only when no session cookie is present, so a stray header cannot bypass CSRF.
  const hasSessionCookie = !!(req.cookies?.access_token || req.cookies?.refresh_token);
  if (req.headers.authorization?.startsWith('Bearer ') && !hasSessionCookie) return next();
  // An MCP client's first call has no credentials at all; it must get 401 with sign-in details.
  if (!hasSessionCookie && req.originalUrl.split('?')[0] === '/api/v1/mcp') return next();
  // Public web-form submissions come from other sites by design: no session, so no CSRF risk.
  const path = req.originalUrl.split('?')[0]!;
  if (
    req.method === 'POST' &&
    (PUBLIC_FORM_SUBMIT.test(path) ||
      PUBLIC_UNSUBSCRIBE.test(path) ||
      OAUTH_CLIENT.test(path) ||
      PUBLIC_BOOKING.test(path))
  )
    return next();
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header) || !validToken(header)) {
    return next(new AppError('CSRF_INVALID', 'Your session token expired. Refresh the page and try again.'));
  }
  next();
}
