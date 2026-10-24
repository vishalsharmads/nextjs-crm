import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { createApp } from '../src/http/app';

/** Writes a fake build: files keyed by relative path. */
function fakeBuild(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

describe('single-server mode (site at /, app at /app)', () => {
  let app: Express;
  beforeAll(() => {
    const webDir = fakeBuild({ 'index.html': 'app shell', 'assets/main-abc123.js': 'app js' });
    const siteDir = fakeBuild({
      'index.html': 'site home',
      'pricing.html': 'site pricing',
      'industries.html': 'site industries',
      'industries/coworking.html': 'site coworking',
      '404.html': 'site not found',
      '_astro/site-abc123.js': 'site js',
    });
    app = createApp({ static: { webDir, siteDir, appPath: '/app' } });
  });

  it('serves site pages, including a page that shares its name with a folder', async () => {
    expect((await request(app).get('/').expect(200)).text).toBe('site home');
    expect((await request(app).get('/pricing').expect(200)).text).toBe('site pricing');
    expect((await request(app).get('/industries').expect(200)).text).toBe('site industries');
    expect((await request(app).get('/industries/coworking').expect(200)).text).toBe('site coworking');
  });

  it("answers unknown site pages with the site's 404 page", async () => {
    const res = await request(app).get('/nope').expect(404);
    expect(res.text).toBe('site not found');
  });

  it('serves the app shell for every app route, and its build files', async () => {
    for (const p of ['/app', '/app/', '/app/login', '/app/contacts/0190a1b2-c3d4']) {
      expect((await request(app).get(p).expect(200)).text).toBe('app shell');
    }
    const js = await request(app).get('/app/assets/main-abc123.js').expect(200);
    expect(js.headers['cache-control']).toContain('immutable');
    await request(app).get('/app/assets/missing.js').expect(404);
  });

  it('sets the page security policy and keeps HTML revalidated', async () => {
    const res = await request(app).get('/app/login').expect(200);
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['cache-control']).toBe('no-cache');
    expect((await request(app).get('/').expect(200)).headers['content-security-policy']).toBeTruthy();
  });

  it('never shadows the API', async () => {
    const res = await request(app).get('/api/v1/nope').expect(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect((await request(app).get('/api/v1/health').expect(200)).body).toEqual({ status: 'ok' });
  });

  it('does not serve files outside the site folder', async () => {
    await request(app).get('/..%2f..%2fetc%2fpasswd').expect(404);
  });
});

describe('without static folders', () => {
  it('serves only the API, as behind nginx', async () => {
    const app = createApp({ static: { webDir: '', siteDir: '', appPath: '/' } });
    const res = await request(app).get('/').expect(404);
    expect(res.headers['content-security-policy'] ?? '').not.toContain("default-src 'self'");
  });
});
