"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.me = exports.resetPassword = exports.forgotPassword = exports.refresh = exports.logout = exports.login = void 0;
const catchAsync_1 = require("@utils/catchAsync");
const index_1 = require("@config/index");
const duration_1 = require("@utils/duration");
const authService = __importStar(require("@services/auth.service"));
function refreshCookieOptions() {
    return {
        httpOnly: true,
        secure: index_1.config.isProd,
        sameSite: index_1.config.isProd ? 'strict' : 'lax',
        maxAge: (0, duration_1.parseDurationMs)(index_1.config.auth.jwtRefreshExpiresIn),
        path: '/api/v1/auth',
    };
}
function setRefreshCookie(res, token) {
    res.cookie(index_1.config.auth.refreshCookieName, token, refreshCookieOptions());
}
function clearRefreshCookie(res) {
    res.clearCookie(index_1.config.auth.refreshCookieName, { ...refreshCookieOptions(), maxAge: undefined });
}
function readRefreshCookie(req) {
    const cookies = req.cookies;
    return cookies?.[index_1.config.auth.refreshCookieName] ?? req.body?.refreshToken;
}
exports.login = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { email, password } = req.body;
    const { user, accessToken, refreshToken } = await authService.login(email, password, req);
    setRefreshCookie(res, refreshToken);
    res.status(200).json({ success: true, data: { user, accessToken, refreshToken } });
});
exports.logout = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const rawRefreshToken = readRefreshCookie(req);
    await authService.logout(rawRefreshToken, req.user?.id, req);
    clearRefreshCookie(res);
    res.status(200).json({ success: true, message: 'Logged out' });
});
exports.refresh = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const rawRefreshToken = readRefreshCookie(req);
    const { user, accessToken, refreshToken } = await authService.refresh(rawRefreshToken, req);
    setRefreshCookie(res, refreshToken);
    res.status(200).json({ success: true, data: { user, accessToken, refreshToken } });
});
exports.forgotPassword = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { email } = req.body;
    await authService.forgotPassword(email, req);
    res.status(200).json({
        success: true,
        message: 'If an account exists for that email, a password reset link has been sent.',
    });
});
exports.resetPassword = (0, catchAsync_1.catchAsync)(async (req, res) => {
    const { token, newPassword } = req.body;
    await authService.resetPassword(token, newPassword, req);
    res.status(200).json({ success: true, message: 'Password has been reset. Please log in again.' });
});
exports.me = (0, catchAsync_1.catchAsync)(async (req, res) => {
    res.status(200).json({ success: true, data: { user: req.user } });
});
//# sourceMappingURL=auth.controller.js.map