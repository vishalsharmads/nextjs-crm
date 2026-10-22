import rateLimit from 'express-rate-limit';
import multer from 'multer';
import sanitize from 'sanitize-html';
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

/** Single-file multipart upload held in memory, with the instance's size limit. Run after access checks. */
export const uploadSingle = (field = 'file') =>
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: env.UPLOAD_MAX_MB * 1024 * 1024, files: 1 },
  }).single(field);

/**
 * Sanitize rich document HTML (generated documents, templates): structure and basic formatting only.
 * No scripts, styles, event handlers or external resources.
 */
export function sanitizeDocumentHtml(html: string): string {
  return sanitize(html, {
    allowedTags: [
      'h1',
      'h2',
      'h3',
      'h4',
      'p',
      'br',
      'hr',
      'strong',
      'b',
      'em',
      'i',
      'u',
      's',
      'ul',
      'ol',
      'li',
      'blockquote',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'a',
      'span',
      'div',
    ],
    allowedAttributes: { a: ['href'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'] },
    allowedSchemes: ['https', 'mailto'],
    transformTags: { a: sanitize.simpleTransform('a', { rel: 'noopener noreferrer' }) },
  });
}
