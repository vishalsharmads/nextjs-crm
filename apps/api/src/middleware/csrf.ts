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

export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  // Bearer-token clients (API keys) are not cookie-authenticated, so CSRF does not apply.
  if (req.headers.authorization?.startsWith('Bearer ')) return next();
  // Public endpoints that are hit cross-site by design (web forms) opt out by path.
  if (req.path.startsWith('/api/v1/public/forms/')) return next();
  const cookie = req.cookies?.[CSRF_COOKIE] as string | undefined;
  const header = req.get(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header) || !validToken(header)) {
    return next(new AppError('CSRF_INVALID', 'Your session token expired. Refresh the page and try again.'));
  }
  next();
}
