"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.notFoundHandler = void 0;
const AppError_1 = require("@utils/AppError");
const notFoundHandler = (req, _res, next) => {
    next(AppError_1.AppError.notFound(`Route not found: ${req.method} ${req.originalUrl}`));
};
exports.notFoundHandler = notFoundHandler;
//# sourceMappingURL=notFound.js.map