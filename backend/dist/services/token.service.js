"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.issueRefreshToken = issueRefreshToken;
exports.rotateRefreshToken = rotateRefreshToken;
exports.revokeRefreshToken = revokeRefreshToken;
exports.revokeAllUserTokens = revokeAllUserTokens;
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const crypto_1 = require("@utils/crypto");
const duration_1 = require("@utils/duration");
const AppError_1 = require("@utils/AppError");
function metaFromRequest(req) {
    return { ipAddress: req?.ip, userAgent: req?.headers['user-agent'] };
}
async function issueRefreshToken(userId, req) {
    const rawToken = (0, crypto_1.generateOpaqueToken)();
    const tokenHash = (0, crypto_1.hashToken)(rawToken, index_1.config.auth.jwtRefreshSecret);
    const { ipAddress, userAgent } = metaFromRequest(req);
    await connection_1.prisma.refreshToken.create({
        data: {
            userId,
            tokenHash,
            expiresAt: (0, duration_1.addDuration)(new Date(), index_1.config.auth.jwtRefreshExpiresIn),
            ipAddress,
            userAgent,
        },
    });
    return rawToken;
}
async function rotateRefreshToken(rawToken, req) {
    const tokenHash = (0, crypto_1.hashToken)(rawToken, index_1.config.auth.jwtRefreshSecret);
    const existing = await connection_1.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) {
        throw AppError_1.AppError.unauthorized('Invalid refresh token');
    }
    if (existing.revokedAt) {
        await revokeAllUserTokens(existing.userId);
        throw AppError_1.AppError.unauthorized('Refresh token has already been used. All sessions have been revoked for safety — please log in again.');
    }
    if (existing.expiresAt < new Date()) {
        throw AppError_1.AppError.unauthorized('Refresh token has expired');
    }
    const newRawToken = (0, crypto_1.generateOpaqueToken)();
    const newTokenHash = (0, crypto_1.hashToken)(newRawToken, index_1.config.auth.jwtRefreshSecret);
    const { ipAddress, userAgent } = metaFromRequest(req);
    await connection_1.prisma.$transaction([
        connection_1.prisma.refreshToken.update({
            where: { id: existing.id },
            data: { revokedAt: new Date(), replacedByTokenHash: newTokenHash },
        }),
        connection_1.prisma.refreshToken.create({
            data: {
                userId: existing.userId,
                tokenHash: newTokenHash,
                expiresAt: (0, duration_1.addDuration)(new Date(), index_1.config.auth.jwtRefreshExpiresIn),
                ipAddress,
                userAgent,
            },
        }),
    ]);
    return { userId: existing.userId, newRawToken };
}
async function revokeRefreshToken(rawToken) {
    const tokenHash = (0, crypto_1.hashToken)(rawToken, index_1.config.auth.jwtRefreshSecret);
    await connection_1.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
async function revokeAllUserTokens(userId) {
    await connection_1.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
    });
}
//# sourceMappingURL=token.service.js.map