"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalAuth = internalAuth;
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
function internalAuth(req, _res, next) {
    const expected = index_1.config.internal.syncApiKey;
    if (!expected) {
        next(AppError_1.AppError.forbidden('Internal sync is not configured on this server (INTERNAL_SYNC_API_KEY is unset)'));
        return;
    }
    const providedHeader = req.headers['x-internal-key'];
    const provided = Array.isArray(providedHeader) ? providedHeader[0] : providedHeader;
    if (!provided || provided !== expected) {
        next(AppError_1.AppError.forbidden('Invalid or missing x-internal-key'));
        return;
    }
    next();
}
//# sourceMappingURL=internalAuth.js.map