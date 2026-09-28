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
const express_1 = require("express");
const authController = __importStar(require("@controllers/auth.controller"));
const auth_1 = require("@middlewares/auth");
const validate_1 = require("@middlewares/validate");
const rateLimiters_1 = require("@middlewares/rateLimiters");
const auth_validators_1 = require("@validators/auth.validators");
const router = (0, express_1.Router)();
router.post('/login', rateLimiters_1.loginRateLimiter, (0, validate_1.validate)(auth_validators_1.loginSchema), authController.login);
router.post('/logout', auth_1.authenticate, authController.logout);
router.post('/refresh', authController.refresh);
router.post('/forgot-password', rateLimiters_1.forgotPasswordRateLimiter, (0, validate_1.validate)(auth_validators_1.forgotPasswordSchema), authController.forgotPassword);
router.post('/reset-password', (0, validate_1.validate)(auth_validators_1.resetPasswordSchema), authController.resetPassword);
router.get('/me', auth_1.authenticate, authController.me);
exports.default = router;
//# sourceMappingURL=auth.routes.js.map