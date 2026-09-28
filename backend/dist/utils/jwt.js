"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signAccessToken = signAccessToken;
exports.verifyAccessToken = verifyAccessToken;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const index_1 = require("@config/index");
function signAccessToken(payload) {
    const options = { expiresIn: index_1.config.auth.jwtExpiresIn };
    return jsonwebtoken_1.default.sign(payload, index_1.config.auth.jwtSecret, options);
}
function verifyAccessToken(token) {
    const decoded = jsonwebtoken_1.default.verify(token, index_1.config.auth.jwtSecret);
    return {
        sub: decoded.sub,
        email: decoded.email,
        role: decoded.role,
        permissions: decoded.permissions ?? [],
    };
}
//# sourceMappingURL=jwt.js.map