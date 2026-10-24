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
            url: req.url,
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
  // Readiness: the database answers too. Use for uptime monitoring and deploy checks.
  app.get('/api/v1/health/ready', async (_req, res) => {
    try {
      await db.raw('SELECT 1');
      res.json({ status: 'ok', database: 'ok' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'unreachable' });
    }
  });

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
