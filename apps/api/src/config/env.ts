import { config as loadDotenv } from 'dotenv';
import path from 'node:path';

// `.env` may live in the API folder or the repo root (npm workspace scripts run from apps/api).
loadDotenv({
  path: [path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')],
  quiet: true,
});
import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_URL: z.url().default('http://localhost:5173'),
  CORS_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  DATABASE_URL: z.string().default('mysql://root@127.0.0.1:3306/crm_dev'),
  DATABASE_URL_TEST: z.string().default('mysql://root@127.0.0.1:3306/crm_test'),

  JWT_SECRET: z.string().min(16).default('dev-only-jwt-secret-change-me'),
  CSRF_SECRET: z.string().min(16).default('dev-only-csrf-secret-change-me'),
  ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-f]{64}$/i, 'ENCRYPTION_KEY must be 64 hex chars (32 bytes)')
    .default('0'.repeat(64)),
  /**
   * Key ring for rotation: `kid:hex64,kid:hex64`. The first key encrypts; all of them decrypt.
   * When unset, ENCRYPTION_KEY is the only key (kid `k0`).
   */
  ENCRYPTION_KEYS: z
    .string()
    .regex(
      /^[a-z0-9_-]{1,16}:[0-9a-f]{64}(,[a-z0-9_-]{1,16}:[0-9a-f]{64})*$/i,
      'ENCRYPTION_KEYS must look like kid:<64 hex>,kid:<64 hex>',
    )
    .optional(),
  FILE_URL_SECRET: z.string().min(16).default('dev-only-file-url-secret'),
  /** Signs unsubscribe links. They never expire, so keep this stable (falls back to CSRF_SECRET). */
  UNSUBSCRIBE_SECRET: z.string().min(16).optional(),
  COOKIE_SECURE: bool.optional(),
  ACCESS_TOKEN_TTL_MIN: z.coerce.number().int().min(1).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).default(14),

  SMTP_HOST: z.string().default('127.0.0.1'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  MAIL_FROM: z.string().default('no-reply@localhost'),

  STORAGE_DIR: z.string().default('./storage'),
  UPLOAD_MAX_MB: z.coerce.number().int().min(1).max(200).default(20),

  REDIS_URL: z.string().default(''),
  /** Allow webhook URLs that resolve to private/loopback addresses (development only). */
  WEBHOOKS_ALLOW_PRIVATE: bool.default(false),
  /** Requests per minute per IP for the API (sign-in has its own, stricter limit). */
  API_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(60).max(1_000_000).default(600),
  /** Show demo accounts (seeded with `demo:seed`) on the sign-in screen. Never on a client instance. */
  DEMO_MODE: bool.default(false),
  /** Serve the built SPA from this process (hosts without nginx). Its path comes from APP_URL. */
  WEB_DIR: z.string().default(''),
  /** Serve a built static site (the marketing site) at the root, next to the SPA under APP_URL's path. */
  SITE_DIR: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

export type Env = z.infer<typeof schema>;

function load(): Env {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment:\n${issues}`);
  }
  const env = parsed.data;
  if (env.NODE_ENV === 'production') {
    // Fail fast on weak or default secrets.
    const weak = (['JWT_SECRET', 'CSRF_SECRET', 'FILE_URL_SECRET'] as const).filter(
      (k) => env[k].startsWith('dev-only') || env[k].length < 32,
    );
    const active = env.ENCRYPTION_KEYS
      ? env.ENCRYPTION_KEYS.split(',')[0]!.split(':')[1]
      : env.ENCRYPTION_KEY;
    if (active === '0'.repeat(64))
      weak.push((env.ENCRYPTION_KEYS ? 'ENCRYPTION_KEYS' : 'ENCRYPTION_KEY') as never);
    if (weak.length) throw new Error(`Weak or default secrets in production: ${weak.join(', ')}`);
  }
  return env;
}

export const env = load();
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const cookieSecure = env.COOKIE_SECURE ?? isProd;
