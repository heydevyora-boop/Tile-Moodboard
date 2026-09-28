"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.prisma = void 0;
exports.connectDatabase = connectDatabase;
exports.disconnectDatabase = disconnectDatabase;
exports.isDatabaseConnected = isDatabaseConnected;
const client_1 = require("@prisma/client");
const adapter_pg_1 = require("@prisma/adapter-pg");
const index_1 = require("@config/index");
const logger_1 = require("@utils/logger");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
    throw new Error("DATABASE_URL is not defined in the environment.");
}
const adapter = new adapter_pg_1.PrismaPg({
    connectionString,
});
const logConfig = index_1.config.isDev
    ? [
        { emit: "event", level: "query" },
        { emit: "event", level: "warn" },
        { emit: "event", level: "error" },
    ]
    : [{ emit: "event", level: "error" }];
exports.prisma = global.__prisma ??
    new client_1.PrismaClient({
        adapter,
        log: logConfig,
    });
if (index_1.config.isDev) {
    global.__prisma = exports.prisma;
    exports.prisma.$on("query", (e) => {
        logger_1.logger.debug(`prisma query (${e.duration}ms): ${e.query}`);
    });
    exports.prisma.$on("warn", (e) => {
        logger_1.logger.warn(`Prisma warning: ${e.message}`);
    });
}
exports.prisma.$on("error", (e) => {
    logger_1.logger.error(`Prisma error: ${e.message}`);
});
let isConnected = false;
async function connectDatabase() {
    try {
        await exports.prisma.$connect();
        await exports.prisma.$queryRaw `SELECT 1`;
        isConnected = true;
        logger_1.logger.info("✅ Database connected");
    }
    catch (err) {
        isConnected = false;
        logger_1.logger.error("❌ Database connection failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}
async function disconnectDatabase() {
    try {
        await exports.prisma.$disconnect();
        isConnected = false;
        logger_1.logger.info("Database disconnected");
    }
    catch (err) {
        logger_1.logger.error("❌ Database disconnect failed", {
            error: err instanceof Error ? err.message : String(err),
        });
        throw err;
    }
}
function isDatabaseConnected() {
    return isConnected;
}
//# sourceMappingURL=connection.js.map