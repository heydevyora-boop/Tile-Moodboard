"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.login = login;
exports.logout = logout;
exports.refresh = refresh;
exports.forgotPassword = forgotPassword;
exports.resetPassword = resetPassword;
const connection_1 = require("@db/connection");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const password_1 = require("@utils/password");
const jwt_1 = require("@utils/jwt");
const crypto_1 = require("@utils/crypto");
const duration_1 = require("@utils/duration");
const token_service_1 = require("./token.service");
const email_service_1 = require("./email.service");
const activityLog_service_1 = require("./activityLog.service");
const loginAttempt_service_1 = require("./loginAttempt.service");
function toSafeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role.name,
        permissions: user.role.permissions,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
    };
}
async function issueTokenPair(user, req) {
    const accessToken = (0, jwt_1.signAccessToken)({
        sub: user.id,
        email: user.email,
        role: user.role.name,
        permissions: user.role.permissions,
    });
    const refreshToken = await (0, token_service_1.issueRefreshToken)(user.id, req);
    return { accessToken, refreshToken };
}
async function login(email, password, req) {
    const user = (await connection_1.prisma.user.findUnique({
        where: { email: email.toLowerCase().trim() },
        include: { role: true },
    }));
    const invalidCredentials = () => AppError_1.AppError.unauthorized('Invalid email or password');
    if (!user) {
        await (0, loginAttempt_service_1.recordLoginAttempt)({ email, success: false, failureReason: 'user_not_found', req });
        throw invalidCredentials();
    }
    if (!user.isActive) {
        await (0, loginAttempt_service_1.recordLoginAttempt)({ email, userId: user.id, success: false, failureReason: 'account_deactivated', req });
        throw AppError_1.AppError.forbidden('This account has been deactivated. Contact an admin.');
    }
    const passwordOk = await (0, password_1.comparePassword)(password, user.passwordHash);
    if (!passwordOk) {
        await (0, loginAttempt_service_1.recordLoginAttempt)({ email, userId: user.id, success: false, failureReason: 'invalid_password', req });
        await (0, activityLog_service_1.logActivity)({ userId: user.id, action: 'user.login_failed', entityType: 'User', entityId: user.id, req });
        throw invalidCredentials();
    }
    const { accessToken, refreshToken } = await issueTokenPair(user, req);
    await connection_1.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await (0, loginAttempt_service_1.recordLoginAttempt)({ email, userId: user.id, success: true, req });
    await (0, activityLog_service_1.logActivity)({ userId: user.id, action: 'user.login', entityType: 'User', entityId: user.id, req });
    return { user: toSafeUser(user), accessToken, refreshToken };
}
async function logout(rawRefreshToken, userId, req) {
    if (rawRefreshToken) {
        await (0, token_service_1.revokeRefreshToken)(rawRefreshToken);
    }
    if (userId) {
        await (0, activityLog_service_1.logActivity)({ userId, action: 'user.logout', entityType: 'User', entityId: userId, req });
    }
}
async function refresh(rawRefreshToken, req) {
    if (!rawRefreshToken)
        throw AppError_1.AppError.unauthorized('No refresh token provided');
    const { userId, newRawToken } = await (0, token_service_1.rotateRefreshToken)(rawRefreshToken, req);
    const user = (await connection_1.prisma.user.findUnique({ where: { id: userId }, include: { role: true } }));
    if (!user || !user.isActive)
        throw AppError_1.AppError.unauthorized('Account no longer active');
    const accessToken = (0, jwt_1.signAccessToken)({
        sub: user.id,
        email: user.email,
        role: user.role.name,
        permissions: user.role.permissions,
    });
    await (0, activityLog_service_1.logActivity)({ userId: user.id, action: 'user.token_refreshed', entityType: 'User', entityId: user.id, req });
    return { user: toSafeUser(user), accessToken, refreshToken: newRawToken };
}
async function forgotPassword(email, req) {
    const user = await connection_1.prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
    if (!user || !user.isActive) {
        return;
    }
    const rawToken = (0, crypto_1.generateOpaqueToken)();
    const tokenHash = (0, crypto_1.hashToken)(rawToken, index_1.config.auth.jwtRefreshSecret);
    await connection_1.prisma.passwordResetToken.create({
        data: {
            userId: user.id,
            tokenHash,
            expiresAt: (0, duration_1.addDuration)(new Date(), index_1.config.auth.passwordResetExpiresIn),
        },
    });
    await email_service_1.emailService.sendPasswordResetEmail(user.email, rawToken);
    await (0, activityLog_service_1.logActivity)({ userId: user.id, action: 'user.password_reset_requested', entityType: 'User', entityId: user.id, req });
}
async function resetPassword(rawToken, newPassword, req) {
    const tokenHash = (0, crypto_1.hashToken)(rawToken, index_1.config.auth.jwtRefreshSecret);
    const resetToken = await connection_1.prisma.passwordResetToken.findUnique({ where: { tokenHash } });
    if (!resetToken)
        throw AppError_1.AppError.badRequest('Invalid or expired reset link');
    if (resetToken.usedAt)
        throw AppError_1.AppError.badRequest('This reset link has already been used');
    if (resetToken.expiresAt < new Date())
        throw AppError_1.AppError.badRequest('This reset link has expired. Request a new one.');
    const passwordHash = await (0, password_1.hashPassword)(newPassword);
    await connection_1.prisma.$transaction([
        connection_1.prisma.user.update({ where: { id: resetToken.userId }, data: { passwordHash } }),
        connection_1.prisma.passwordResetToken.update({ where: { id: resetToken.id }, data: { usedAt: new Date() } }),
    ]);
    await (0, token_service_1.revokeAllUserTokens)(resetToken.userId);
    await (0, activityLog_service_1.logActivity)({ userId: resetToken.userId, action: 'user.password_reset_completed', entityType: 'User', entityId: resetToken.userId, req });
}
//# sourceMappingURL=auth.service.js.map