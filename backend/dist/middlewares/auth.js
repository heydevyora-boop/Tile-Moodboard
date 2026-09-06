"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.authenticate = authenticate;
exports.authenticateOptional = authenticateOptional;
exports.authorize = authorize;
exports.requirePermission = requirePermission;
const jwt_1 = require("@utils/jwt");
const AppError_1 = require("@utils/AppError");
function extractBearerToken(req) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
        return null;
    return header.slice('Bearer '.length).trim() || null;
}
function authenticate(req, _res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        next(AppError_1.AppError.unauthorized('Authentication required'));
        return;
    }
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        req.user = {
            id: payload.sub,
            email: payload.email,
            role: payload.role,
            permissions: payload.permissions,
        };
        next();
    }
    catch (err) {
        next(err);
    }
}
function authenticateOptional(req, _res, next) {
    const token = extractBearerToken(req);
    if (!token) {
        next();
        return;
    }
    try {
        const payload = (0, jwt_1.verifyAccessToken)(token);
        req.user = { id: payload.sub, email: payload.email, role: payload.role, permissions: payload.permissions };
    }
    catch {
    }
    next();
}
function authorize(...allowedRoles) {
    return (req, _res, next) => {
        if (!req.user) {
            next(AppError_1.AppError.unauthorized('Authentication required'));
            return;
        }
        if (!allowedRoles.includes(req.user.role)) {
            next(AppError_1.AppError.forbidden('You do not have permission to perform this action'));
            return;
        }
        next();
    };
}
function requirePermission(permission) {
    return (req, _res, next) => {
        if (!req.user) {
            next(AppError_1.AppError.unauthorized('Authentication required'));
            return;
        }
        const hasPermission = req.user.permissions.includes('*') || req.user.permissions.includes(permission);
        if (!hasPermission) {
            next(AppError_1.AppError.forbidden(`Missing required permission: ${permission}`));
            return;
        }
        next();
    };
}
//# sourceMappingURL=auth.js.map