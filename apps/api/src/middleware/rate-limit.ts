import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env';
import { AppError } from '../lib/errors';

const handler = () => {
  throw new AppError('RATE_LIMITED', 'Too many attempts. Wait a minute and try again.');
};

/** Auth endpoints: per-IP limit. Per-account lockout is enforced separately in the auth service. */
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 1000 : 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 100_000 : env.API_RATE_LIMIT_PER_MIN,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

/** Expensive maintenance endpoints (audit integrity check). */
export const verifyLimiter = rateLimit({
  windowMs: 60_000,
  limit: isTest ? 1000 : 3,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});
