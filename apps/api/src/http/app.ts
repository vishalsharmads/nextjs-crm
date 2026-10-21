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

export interface AppOptions {
  /** Extra route groups (enabled modules). */
  extraGroups?: RouteGroup[];
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
        autoLogging: { ignore: (req) => req.url === '/api/v1/health' },
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

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api', authenticate, csrfProtection, apiLimiter);

  routeRegistry.length = 0;
  const router = createApiRouter();
  mountGroups(router, [...coreRouteGroups(), ...(opts.extraGroups ?? [])]);
  app.use('/api/v1', router);

  app.use('/api', notFoundHandler);
  app.use(errorHandler);
  return app;
}
