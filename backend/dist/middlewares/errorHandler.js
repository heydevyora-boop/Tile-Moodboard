"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerProcessErrorHandlers = exports.globalErrorHandler = void 0;
const zod_1 = require("zod");
const AppError_1 = require("@utils/AppError");
const logger_1 = require("@utils/logger");
const index_1 = require("@config/index");
const errorLog_service_1 = require("@services/errorLog.service");
function isObject(value) {
    return typeof value === "object" && value !== null;
}
function getPrismaErrorCode(err) {
    if (!isObject(err)) {
        return undefined;
    }
    const code = err.code;
    return typeof code === "string" ? code : undefined;
}
function getPrismaErrorTarget(err) {
    if (!isObject(err)) {
        return [];
    }
    const meta = err.meta;
    if (!isObject(meta)) {
        return [];
    }
    const target = meta.target;
    if (Array.isArray(target)) {
        return target.map(String);
    }
    if (typeof target === "string") {
        return [target];
    }
    return [];
}
function isPrismaKnownRequestError(err) {
    const code = getPrismaErrorCode(err);
    return (typeof code === "string" &&
        /^P\d{4}$/.test(code));
}
function isPrismaValidationError(err) {
    if (!isObject(err)) {
        return false;
    }
    const name = err.name;
    return name === "PrismaClientValidationError";
}
function normalizeError(err) {
    if (err instanceof AppError_1.AppError) {
        return err;
    }
    if (err instanceof zod_1.ZodError) {
        return AppError_1.AppError.badRequest("Validation failed", err.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
        })));
    }
    if (isPrismaKnownRequestError(err)) {
        const code = getPrismaErrorCode(err);
        switch (code) {
            case "P2002": {
                const target = getPrismaErrorTarget(err);
                return AppError_1.AppError.conflict(`Duplicate value for field(s): ${target.length > 0
                    ? target.join(", ")
                    : "unknown"}`);
            }
            case "P2025":
                return AppError_1.AppError.notFound("Record not found");
            case "P2003":
                return AppError_1.AppError.badRequest("Invalid reference to a related record");
            default:
                return AppError_1.AppError.badRequest(`Database request error (${code ?? "UNKNOWN"})`);
        }
    }
    if (isPrismaValidationError(err)) {
        return AppError_1.AppError.badRequest("Invalid data sent to the database layer");
    }
    if (err instanceof Error) {
        if (err.name === "JsonWebTokenError") {
            return AppError_1.AppError.unauthorized("Invalid authentication token");
        }
        if (err.name === "TokenExpiredError") {
            return AppError_1.AppError.unauthorized("Authentication token has expired");
        }
        if (err.name === "MulterError") {
            return AppError_1.AppError.badRequest(`File upload error: ${err.message}`);
        }
        const unknown = new AppError_1.AppError(index_1.config.isProd
            ? "Something went wrong"
            : err.message, 500);
        unknown.stack = err.stack;
        return unknown;
    }
    return AppError_1.AppError.internal("An unexpected error occurred");
}
const globalErrorHandler = (err, req, res, _next) => {
    const error = normalizeError(err);
    const logPayload = {
        method: req.method,
        path: req.originalUrl,
        ip: req.ip,
        statusCode: error.statusCode,
        userId: req.user?.id,
    };
    if (error.statusCode >= 500) {
        logger_1.logger.error(error.message, {
            ...logPayload,
            stack: error.stack,
            details: error.details,
        });
        void (0, errorLog_service_1.recordErrorLog)({
            message: error.message,
            stack: error.stack,
            statusCode: error.statusCode,
            path: req.originalUrl,
            method: req.method,
            userId: logPayload.userId,
            metadata: error.details
                ? {
                    details: error.details,
                }
                : undefined,
        });
    }
    else {
        logger_1.logger.warn(error.message, logPayload);
    }
    const body = {
        success: false,
        status: error.status,
        message: error.message,
    };
    if (error.details) {
        body.errors = error.details;
    }
    if (index_1.config.isDev) {
        body.stack = error.stack;
    }
    res
        .status(error.statusCode)
        .json(body);
};
exports.globalErrorHandler = globalErrorHandler;
const registerProcessErrorHandlers = () => {
    process.on("uncaughtException", (err) => {
        logger_1.logger.error("UNCAUGHT EXCEPTION — shutting down", {
            message: err.message,
            stack: err.stack,
        });
        process.exit(1);
    });
    process.on("unhandledRejection", (reason) => {
        const message = reason instanceof Error
            ? reason.message
            : String(reason);
        const stack = reason instanceof Error
            ? reason.stack
            : undefined;
        logger_1.logger.error("UNHANDLED PROMISE REJECTION — shutting down", {
            message,
            stack,
        });
        process.exit(1);
    });
};
exports.registerProcessErrorHandlers = registerProcessErrorHandlers;
//# sourceMappingURL=errorHandler.js.map