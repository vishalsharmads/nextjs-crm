import { env } from './config/env';
import { logger } from './lib/logger';
import { bootstrap } from './boot';

const { app, shutdown } = await bootstrap();
const server = app.listen(env.PORT, () => logger.info(`API listening on :${env.PORT}`));

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    logger.info(`${signal} received, shutting down`);
    server.close(() => {
      void shutdown().then(() => process.exit(0));
    });
  });
}
