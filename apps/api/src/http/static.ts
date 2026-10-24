import express, { type Express, type RequestHandler } from 'express';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Optional single-server mode for hosts without nginx (shared hosting, demo servers): the API process
 * also serves the built SPA under `appPath` and, if given, a static site (e.g. the marketing site) at
 * everything else. Client instances behind nginx leave both directories unset.
 */
export interface StaticOptions {
  /** Built SPA (`apps/web/dist`), served under `appPath`. */
  webDir?: string;
  /** Built static site (`apps/site/dist`), served at the root. Ignored when the app is at the root. */
  siteDir?: string;
  /** Path the SPA is served under, matching its build `base` ('/' or e.g. '/app'). */
  appPath: string;
}

/** Same policy nginx sets for the SPA (deploy/nginx.conf.example). */
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
  "connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'";

const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

/** Hashed build files never change; HTML must be revalidated so a deploy shows up at once. */
function cacheHeaders(res: express.Response, file: string) {
  const hashed = /[\\/](assets|_astro)[\\/]/.test(file);
  res.setHeader('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
}

const isPageRequest = (req: express.Request) =>
  (req.method === 'GET' || req.method === 'HEAD') && !req.path.startsWith('/api/');

export function mountStatic(app: Express, opts: StaticOptions): void {
  const appPath = `/${opts.appPath.replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
  if (!opts.webDir && !opts.siteDir) return;
  app.use((req, res, next) => (isPageRequest(req) ? securityHeaders(req, res, next) : next()));

  if (opts.webDir) {
    const webDir = path.resolve(opts.webDir);
    const index = path.join(webDir, 'index.html');
    const spa = express.Router();
    spa.use(express.static(webDir, { index: false, redirect: false, setHeaders: cacheHeaders }));
    // Client-side routes: any other page under the app path gets the SPA shell.
    spa.use((req, res, next) => {
      if (!isPageRequest(req) || path.extname(req.path)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(index);
    });
    app.use(appPath || '/', spa);
  }

  if (opts.siteDir && appPath) {
    const siteDir = path.resolve(opts.siteDir);
    app.use(express.static(siteDir, { extensions: ['html'], redirect: false, setHeaders: cacheHeaders }));
    // Pages are built as `name.html` next to a `name/` folder; serve the file for `/name` and `/name/`.
    app.use((req, res, next) => {
      if (!isPageRequest(req)) return next();
      const page = path.join(siteDir, `${req.path.replace(/\/+$/, '')}.html`);
      if (!page.startsWith(siteDir + path.sep) || !fs.existsSync(page)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(page);
    });
    const notFound = path.join(siteDir, '404.html');
    app.use((req, res, next) => {
      if (!isPageRequest(req) || !fs.existsSync(notFound)) return next();
      res.status(404).sendFile(notFound);
    });
  }
}
