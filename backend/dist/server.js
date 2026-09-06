"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("tsconfig-paths/register");
const http_1 = __importDefault(require("http"));
const index_1 = require("@config/index");
const logger_1 = require("@utils/logger");
const errorHandler_1 = require("@middlewares/errorHandler");
const connection_1 = require("@db/connection");
const imageProcessingQueue_service_1 = require("@services/imageProcessingQueue.service");
const exportQueue_service_1 = require("@services/exportQueue.service");
const app_1 = require("./app");
(0, errorHandler_1.registerProcessErrorHandlers)();
async function bootstrap() {
    await (0, connection_1.connectDatabase)();
    (0, imageProcessingQueue_service_1.registerImageProcessingQueue)();
    (0, exportQueue_service_1.registerExportQueue)();
    const app = (0, app_1.createApp)();
    const server = http_1.default.createServer(app);
    server.listen(index_1.config.app.port, () => {
        logger_1.logger.info(`🚀 ${index_1.config.app.name} running in ${index_1.config.env} mode on port ${index_1.config.app.port}`);
        logger_1.logger.info(`   API base: http://localhost:${index_1.config.app.port}${index_1.config.app.apiPrefix}`);
        logger_1.logger.info(`   Health:   http://localhost:${index_1.config.app.port}${index_1.config.app.apiPrefix}/health`);
    });
    const shutdown = async (signal) => {
        logger_1.logger.info(`${signal} received. Shutting down gracefully...`);
        server.close(async () => {
            await (0, connection_1.disconnectDatabase)();
            logger_1.logger.info('Shutdown complete.');
            process.exit(0);
        });
        setTimeout(() => {
            logger_1.logger.error('Forced shutdown after timeout.');
            process.exit(1);
        }, 10000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
bootstrap().catch((err) => {
    logger_1.logger.error('Fatal error during startup', { message: err.message, stack: err.stack });
    process.exit(1);
});
//# sourceMappingURL=server.js.map