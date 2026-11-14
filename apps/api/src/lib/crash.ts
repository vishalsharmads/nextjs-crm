import { env } from '../config/env';
import { logger } from './logger';
import { safePost } from './safe-net';

/**
 * Report a fatal error to ERROR_WEBHOOK_URL (optional) and wait at most two seconds.
 * The body carries the error name and message and the stack, never request data.
 */
export async function reportError(err: unknown, kind: string) {
  if (!env.ERROR_WEBHOOK_URL) return;
  const e = err instanceof Error ? err : new Error(String(err));
  const body = JSON.stringify({
    kind,
    at: new Date().toISOString(),
    app: new URL(env.APP_URL).host,
    error: { name: e.name, message: e.message.slice(0, 2000), stack: e.stack?.slice(0, 8000) },
  });
  await safePost(env.ERROR_WEBHOOK_URL, { 'Content-Type': 'application/json' }, body, {
    timeoutMs: 2000,
    allowPrivate: env.WEBHOOKS_ALLOW_PRIVATE,
  }).catch((reportErr: unknown) => logger.warn({ err: reportErr }, 'Error report failed'));
}

/**
 * A crash leaves the process in an unknown state: log it as fatal, report it, and exit so
 * systemd restarts a clean process.
 */
export function installCrashHandlers() {
  const die = (kind: string) => (err: unknown) => {
    logger.fatal({ err }, kind);
    void reportError(err, kind).finally(() => process.exit(1));
  };
  process.on('uncaughtException', die('uncaughtException'));
  process.on('unhandledRejection', die('unhandledRejection'));
}
