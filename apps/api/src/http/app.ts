import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { redisStatus } from '../lib/jobs';
import { db } from '../db/knex';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import { env, isTest } from '../config/env';
import { logger } from '../lib/logger';
import { contextMiddleware, authenticate } from '../middleware/authenticate';
import { csrfProtection } from '../middleware/csrf';
import { apiLimiter } from '../middleware/rate-limit';
import { errorHandler, notFoundHandler } from '../middleware/error-handler';
import { createApiRouter, mountGroups, routeRegistry, type RouteGroup } from './routes';
import { coreRouteGroups } from '../core/routes';
import { oauthWellKnownRouter } from '../core/oauth/oauth';
import { mountStatic, type StaticOptions } from './static';

export interface AppOptions {
  /** Extra route groups (enabled modules). */
  extraGroups?: RouteGroup[];
  /** Also serve the built SPA (and optionally a static site) from this process. */
  static?: StaticOptions;
}

export function createApp(opts: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'extended');

  app.use(
    helmet({
      contentSecurityPolicy: false, // API returns JSON; the SPA's CSP is set by nginx.
      crossOriginResourcePolicy: { policy: 'same-origin' },
    }),
  );
  const origins = env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length) app.use(cors({ origin: origins, credentials: true }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  // OAuth token requests are form-encoded (RFC 6749); nothing else accepts form posts.
  app.use('/api/v1/oauth', express.urlencoded({ extended: false, limit: '16kb' }));
  app.use(contextMiddleware);
  if (!isTest) {
    app.use(
      pinoHttp({
        logger,
        genReqId: (req) => (req as express.Request).ctx?.requestId ?? 'unknown',
        autoLogging: { ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false },
        // One compact line per request: no headers (cookies stay out of logs entirely).
        serializers: {
          req: (req: { id: string; method: string; url: string }) => ({
            id: req.id,
            method: req.method,
            url: redactQuery(req.url),
          }),
          res: (res: { statusCode: number }) => ({ status: res.statusCode }),
        },
      }),
    );
  }

  // Liveness: the process answers. Use for restarts (systemd, load balancer).
  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  // Readiness: the database, file storage and (when used) Redis answer too. Use for uptime
  // monitoring and deploy checks. Only states are returned, never addresses or errors.
  app.get('/api/v1/health/ready', async (_req, res) => {
    const [database, files, redis] = await Promise.all([
      db
        .raw('SELECT 1')
        .then(() => 'ok' as const)
        .catch(() => 'unreachable' as const),
      // Storage creates its folder on first upload, so a missing one is created here too.
      mkdir(path.resolve(env.STORAGE_DIR), { recursive: true })
        .then(() => access(path.resolve(env.STORAGE_DIR), fsConstants.W_OK))
        .then(() => 'ok' as const)
        .catch(() => 'unwritable' as const),
      redisStatus(),
    ]);
    const ok = database === 'ok' && files === 'ok' && redis !== 'unreachable';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', database, storage: files, redis });
  });

  // OAuth discovery for MCP clients lives at the site root (RFC 8414, RFC 9728).
  app.use(oauthWellKnownRouter());

  app.use('/api', authenticate, csrfProtection, apiLimiter);

  routeRegistry.length = 0;
  const router = createApiRouter();
  mountGroups(router, [...coreRouteGroups(), ...(opts.extraGroups ?? [])]);
  app.use('/api/v1', router);

  app.use('/api', notFoundHandler);
  if (opts.static) mountStatic(app, opts.static);
  app.use(errorHandler);
  return app;
}

/** Query values that are safe to log. Everything else (search terms, filters, tokens) is masked. */
const LOGGABLE_QUERY = new Set([
  'page',
  'pageSize',
  'sort',
  'view',
  'limit',
  'kinds',
  'inline',
  'status',
  'entity',
]);

/** Search terms and filters often contain names and emails: keep the keys, mask the values. */
export function redactQuery(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const params = new URLSearchParams(url.slice(i + 1));
  const out = [...params].map(([k, v]) => `${k}=${LOGGABLE_QUERY.has(k) ? v : '*'}`);
  return `${url.slice(0, i)}?${out.join('&')}`;
}
