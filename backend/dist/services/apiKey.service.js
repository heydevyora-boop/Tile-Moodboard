"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listApiKeys = listApiKeys;
exports.createApiKey = createApiKey;
exports.rotateApiKey = rotateApiKey;
exports.setApiKeyActive = setApiKeyActive;
exports.deleteApiKey = deleteApiKey;
exports.deactivateAllKeys = deactivateAllKeys;
exports.resolveActiveKeyValue = resolveActiveKeyValue;
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const crypto_1 = require("@utils/crypto");
const activityLog_service_1 = require("./activityLog.service");
const encryptionKey = (0, crypto_1.deriveEncryptionKey)(index_1.config.auth.encryptionKey);
function maskValue(plaintext) {
    if (plaintext.length <= 8)
        return '****';
    return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}
function toPublicShape(row) {
    let masked = '(unreadable)';
    try {
        masked = maskValue((0, crypto_1.decryptSecret)(row.encryptedValue, encryptionKey));
    }
    catch {
    }
    return {
        id: row.id,
        service: row.service,
        label: row.label,
        maskedValue: masked,
        isActive: row.isActive,
        lastRotatedAt: row.lastRotatedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        createdBy: row.createdBy ?? null,
    };
}
async function listApiKeys(query) {
    const rows = await connection_1.prisma.apiKey.findMany({
        where: query.service ? { service: query.service } : {},
        include: { createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
    });
    return rows.map(toPublicShape);
}
async function createApiKey(input, actorId, req) {
    const encryptedValue = (0, crypto_1.encryptSecret)(input.value, encryptionKey);
    const row = await connection_1.prisma.apiKey.create({
        data: { service: input.service, label: input.label, encryptedValue, createdById: actorId, lastRotatedAt: new Date() },
        include: { createdBy: { select: { id: true, name: true } } },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'api_key.created', entityType: 'ApiKey', entityId: row.id, metadata: { service: input.service, label: input.label }, req });
    return toPublicShape(row);
}
async function rotateApiKey(id, input, actorId, req) {
    const existing = await connection_1.prisma.apiKey.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('API key not found');
    const encryptedValue = (0, crypto_1.encryptSecret)(input.value, encryptionKey);
    const row = await connection_1.prisma.apiKey.update({
        where: { id },
        data: { encryptedValue, lastRotatedAt: new Date() },
        include: { createdBy: { select: { id: true, name: true } } },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'api_key.rotated', entityType: 'ApiKey', entityId: id, metadata: { service: existing.service, label: existing.label }, req });
    return toPublicShape(row);
}
async function setApiKeyActive(id, isActive, actorId, req) {
    const existing = await connection_1.prisma.apiKey.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('API key not found');
    const row = await connection_1.prisma.apiKey.update({
        where: { id },
        data: { isActive },
        include: { createdBy: { select: { id: true, name: true } } },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: isActive ? 'api_key.activated' : 'api_key.deactivated', entityType: 'ApiKey', entityId: id, req });
    return toPublicShape(row);
}
async function deleteApiKey(id, actorId, req) {
    const existing = await connection_1.prisma.apiKey.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('API key not found');
    await connection_1.prisma.apiKey.delete({ where: { id } });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'api_key.deleted', entityType: 'ApiKey', entityId: id, metadata: { service: existing.service, label: existing.label }, req });
}
async function deactivateAllKeys(actorId, req) {
    const activeKeys = await connection_1.prisma.apiKey.findMany({ where: { isActive: true } });
    for (const key of activeKeys) {
        await connection_1.prisma.apiKey.update({ where: { id: key.id }, data: { isActive: false } });
    }
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'api_key.deactivated_all',
        metadata: { count: activeKeys.length, keyIds: activeKeys.map((k) => k.id) },
        req,
    });
    return { deactivatedCount: activeKeys.length };
}
async function resolveActiveKeyValue(service) {
    const row = await connection_1.prisma.apiKey.findFirst({ where: { service, isActive: true }, orderBy: { updatedAt: 'desc' } });
    if (!row)
        return null;
    try {
        return (0, crypto_1.decryptSecret)(row.encryptedValue, encryptionKey);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=apiKey.service.js.map