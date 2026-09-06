"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.httpLogStream = exports.logger = void 0;
const fs_1 = __importDefault(require("fs"));
const winston_1 = __importDefault(require("winston"));
const winston_daily_rotate_file_1 = __importDefault(require("winston-daily-rotate-file"));
const index_1 = require("@config/index");
if (!fs_1.default.existsSync(index_1.config.log.dir)) {
    fs_1.default.mkdirSync(index_1.config.log.dir, { recursive: true });
}
const { combine, timestamp, printf, colorize, errors, json } = winston_1.default.format;
const consoleFormat = combine(colorize(), timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }), errors({ stack: true }), printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] ${level}: ${stack || message}${metaStr}`;
}));
const fileFormat = combine(timestamp(), errors({ stack: true }), json());
const fileTransport = new winston_daily_rotate_file_1.default({
    dirname: index_1.config.log.dir,
    filename: 'app-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: fileFormat,
});
const errorFileTransport = new winston_daily_rotate_file_1.default({
    dirname: index_1.config.log.dir,
    filename: 'error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    level: 'error',
    format: fileFormat,
});
exports.logger = winston_1.default.createLogger({
    level: index_1.config.log.level,
    transports: [
        new winston_1.default.transports.Console({ format: consoleFormat }),
        fileTransport,
        errorFileTransport,
    ],
    exitOnError: false,
});
exports.httpLogStream = {
    write: (message) => exports.logger.http(message.trim()),
};
//# sourceMappingURL=logger.js.map