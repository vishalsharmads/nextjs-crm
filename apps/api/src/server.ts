import { env } from './config/env';
import { logger } from './lib/logger';
import { bootstrap } from './boot';
import { installCrashHandlers } from './lib/crash';

installCrashHandlers();
const { app, shutdown } = await bootstrap();
const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

const SHUTDOWN_TIMEOUT_MS = 15_000;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    logger.info(`${signal} received, shutting down`);
    // Give open requests time to finish, then cut them off so the process always exits.
    const force = setTimeout(() => {
      logger.warn('Shutdown timed out; closing open connections');
      server.closeAllConnections();
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    force.unref();
    server.closeIdleConnections();
    server.close(() => {
      void shutdown()
        .catch((err: unknown) => logger.error({ err }, 'Shutdown failed'))
        .finally(() => process.exit(0));
    });
  });
}
