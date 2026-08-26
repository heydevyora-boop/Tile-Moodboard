import 'tsconfig-paths/register';
import http from 'http';
import { config } from '@config/index';
import { logger } from '@utils/logger';
import { registerProcessErrorHandlers } from '@middlewares/errorHandler';
import { connectDatabase, disconnectDatabase } from '@db/connection';
import { registerImageProcessingQueue } from '@services/imageProcessingQueue.service';
import { registerExportQueue } from '@services/exportQueue.service';
import { createApp } from './app';

registerProcessErrorHandlers();

async function bootstrap() {
  await connectDatabase();

  registerImageProcessingQueue();
  registerExportQueue();

  const app = createApp();
  const server = http.createServer(app);

  server.listen(config.app.port, () => {
    logger.info(`🚀 ${config.app.name} running in ${config.env} mode on port ${config.app.port}`);
    logger.info(`   API base: http://localhost:${config.app.port}${config.app.apiPrefix}`);
    logger.info(`   Health:   http://localhost:${config.app.port}${config.app.apiPrefix}/health`);
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Shutting down gracefully...`);
    server.close(async () => {
      await disconnectDatabase();
      logger.info('Shutdown complete.');
      process.exit(0);
    });

    // Force-exit if graceful shutdown hangs
    setTimeout(() => {
      logger.error('Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  logger.error('Fatal error during startup', { message: err.message, stack: err.stack });
  process.exit(1);
});
