"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.printBoardExportRateLimiter = exports.moodBoardGenerationRateLimiter = exports.forgotPasswordRateLimiter = exports.loginRateLimiter = void 0;
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
exports.loginRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 'fail', message: 'Too many login attempts. Please try again in a few minutes.' },
    skipSuccessfulRequests: true,
});
exports.forgotPasswordRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 'fail', message: 'Too many password reset requests. Please try again later.' },
});
exports.moodBoardGenerationRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 'fail', message: 'Too many mood board generation requests. Please slow down.' },
});
exports.printBoardExportRateLimiter = (0, express_rate_limit_1.default)({
    windowMs: 5 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, status: 'fail', message: 'Too many export requests. Please slow down.' },
});
//# sourceMappingURL=rateLimiters.js.map