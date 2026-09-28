"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logActivity = logActivity;
const connection_1 = require("@db/connection");
const logger_1 = require("@utils/logger");
async function logActivity({ userId, action, entityType, entityId, metadata, req }) {
    try {
        await connection_1.prisma.activityLog.create({
            data: {
                userId: userId ?? undefined,
                action,
                entityType,
                entityId,
                metadata: metadata,
                ipAddress: req?.ip,
                userAgent: req?.headers['user-agent'],
            },
        });
    }
    catch (err) {
        logger_1.logger.error('Failed to write activity log', { action, error: err.message });
    }
}
//# sourceMappingURL=activityLog.service.js.map