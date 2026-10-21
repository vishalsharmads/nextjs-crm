import rateLimit from 'express-rate-limit';
import { cookieSecure, env, isTest } from '../config/env';
import { AppError } from '../lib/errors';

/** Per-IP limiter for module routes that face the public internet. Generous in tests. */
export function rateLimiter(limit: number, windowMs = 60_000) {
  return rateLimit({
    windowMs,
    limit: isTest ? 1000 : limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: () => {
      throw new AppError('RATE_LIMITED', 'Too many attempts. Try again in a minute.');
    },
  });
}

/** Absolute link into the web app, for emails. */
export const appUrl = (path: string) => `${env.APP_URL.replace(/\/$/, '')}${path}`;

/** httpOnly cookie settings matching the app's own session cookies. */
export const cookieOptions = (path: string, maxAgeMs: number) =>
  ({ httpOnly: true, secure: cookieSecure, sameSite: 'strict', path, maxAge: maxAgeMs }) as const;
