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

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  // Bearer-token clients (API keys) are not cookie-authenticated, so CSRF does not apply —
  // but only when no session cookie is present, so a stray header cannot bypass CSRF.
  const hasSessionCookie = !!(req.cookies?.access_token || req.cookies?.refresh_token);
  if (req.headers.authorization?.startsWith('Bearer ') && !hasSessionCookie) return next();
  // Public web-form submissions come from other sites by design: no session, so no CSRF risk.
  if (req.method === 'POST' && PUBLIC_FORM_SUBMIT.test(req.originalUrl.split('?')[0]!)) return next();
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header) || !validToken(header)) {
    return next(new AppError('CSRF_INVALID', 'Your session token expired. Refresh the page and try again.'));
  }
  next();
}
