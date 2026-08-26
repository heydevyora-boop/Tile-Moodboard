import fs from 'fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '@config/index';

// Ensure the log directory exists before winston tries to write to it
if (!fs.existsSync(config.log.dir)) {
  fs.mkdirSync(config.log.dir, { recursive: true });
}

const { combine, timestamp, printf, colorize, errors, json } = winston.format;

const consoleFormat = combine(
  colorize(),
  timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `[${ts}] ${level}: ${stack || message}${metaStr}`;
  }),
);

const fileFormat = combine(timestamp(), errors({ stack: true }), json());

const fileTransport = new DailyRotateFile({
  dirname: config.log.dir,
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '14d',
  format: fileFormat,
});

const errorFileTransport = new DailyRotateFile({
  dirname: config.log.dir,
  filename: 'error-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  zippedArchive: true,
  maxSize: '20m',
  maxFiles: '30d',
  level: 'error',
  format: fileFormat,
});

export const logger = winston.createLogger({
  level: config.log.level,
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    fileTransport,
    errorFileTransport,
  ],
  exitOnError: false,
});

/**
 * Stream adapter so morgan (HTTP request logging middleware) can pipe
 * its output through winston instead of writing straight to stdout.
 */
export const httpLogStream = {
  write: (message: string) => logger.http(message.trim()),
};
