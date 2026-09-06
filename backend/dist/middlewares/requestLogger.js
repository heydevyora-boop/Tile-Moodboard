"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.requestLogger = void 0;
const morgan_1 = __importDefault(require("morgan"));
const logger_1 = require("@utils/logger");
const index_1 = require("@config/index");
const format = index_1.config.isDev ? 'dev' : 'combined';
exports.requestLogger = (0, morgan_1.default)(format, { stream: logger_1.httpLogStream });
//# sourceMappingURL=requestLogger.js.map