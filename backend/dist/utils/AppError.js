"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppError = void 0;
class AppError extends Error {
    constructor(message, statusCode = 500, details) {
        super(message);
        this.statusCode = statusCode;
        this.status = statusCode >= 400 && statusCode < 500 ? 'fail' : 'error';
        this.isOperational = true;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
    static badRequest(message = 'Bad request', details) {
        return new AppError(message, 400, details);
    }
    static unauthorized(message = 'Unauthorized') {
        return new AppError(message, 401);
    }
    static forbidden(message = 'Forbidden') {
        return new AppError(message, 403);
    }
    static notFound(message = 'Resource not found') {
        return new AppError(message, 404);
    }
    static conflict(message = 'Conflict', details) {
        return new AppError(message, 409, details);
    }
    static tooManyRequests(message = 'Too many requests') {
        return new AppError(message, 429);
    }
    static internal(message = 'Internal server error', details) {
        return new AppError(message, 500, details);
    }
}
exports.AppError = AppError;
//# sourceMappingURL=AppError.js.map