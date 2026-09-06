import fs from 'fs';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { config } from '@config/index';

// Ensure the log directory exists before winston tries to write to it.
// Vercel/Lambda mount the deployment bundle read-only (only /tmp is writable),
// so this mkdir throws ENOENT at import time and takes the whole process down
// -- which is what turned every /api/v1/* request into a 500. File logs are of
// no use on a serverless container anyway: it is discarded after the
// invocation and the platform already captures stdout, while the admin log
// screens read from the database (logs.service.ts), not from these files. So
// the file transports below are attached only when the directory is writable.
let fileLoggingEnabled = false;

try {
  if (!fs.existsSync(config.log.dir)) {
    fs.mkdirSync(config.log.dir, { recursive: true });
  }
  fileLoggingEnabled = true;
} catch {
  // Console-only logging; see comment above.
  fileLoggingEnabled = false;
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

const transports: winston.transport[] = [
  new winston.transports.Console({ format: consoleFormat }),
];

if (fileLoggingEnabled) {
  transports.push(
    new DailyRotateFile({
      dirname: config.log.dir,
      filename: 'app-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: fileFormat,
    }),
    new DailyRotateFile({
      dirname: config.log.dir,
      filename: 'error-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '30d',
      level: 'error',
      format: fileFormat,
    }),
  );
}

export const logger = winston.createLogger({
  level: config.log.level,
  transports,
  exitOnError: false,
});

/**
 * Stream adapter so morgan (HTTP request logging middleware) can pipe
 * its output through winston instead of writing straight to stdout.
 */
export const httpLogStream = {
  write: (message: string) => logger.http(message.trim()),
};
