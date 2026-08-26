import { NextFunction, Request, Response } from "express";

import { ZodError } from "zod";

import { AppError } from "@utils/AppError";
import { logger } from "@utils/logger";
import { config } from "@config/index";
import { recordErrorLog } from "@services/errorLog.service";

interface ErrorResponseBody {
  success: false;
  status: string;
  message: string;
  errors?: unknown;
  stack?: string;
}

/**
 * Safely checks whether a thrown value is an object.
 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Safely gets a Prisma error code.
 */
function getPrismaErrorCode(err: unknown): string | undefined {
  if (!isObject(err)) {
    return undefined;
  }

  const code = err.code;

  return typeof code === "string" ? code : undefined;
}

/**
 * Safely gets Prisma error metadata.
 */
function getPrismaErrorTarget(err: unknown): string[] {
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

/**
 * Detects Prisma known request errors without using
 * Prisma's internal runtime import.
 */
function isPrismaKnownRequestError(err: unknown): boolean {
  const code = getPrismaErrorCode(err);

  return (
    typeof code === "string" &&
    /^P\d{4}$/.test(code)
  );
}

/**
 * Detects Prisma validation errors.
 */
function isPrismaValidationError(err: unknown): boolean {
  if (!isObject(err)) {
    return false;
  }

  const name = err.name;

  return name === "PrismaClientValidationError";
}

/**
 * Normalizes any thrown value into a consistent AppError.
 */
function normalizeError(err: unknown): AppError {
  /*
   * Already a known application error.
   */
  if (err instanceof AppError) {
    return err;
  }

  /*
   * Zod validation error.
   */
  if (err instanceof ZodError) {
    return AppError.badRequest(
      "Validation failed",
      err.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }

  /*
   * Prisma known request error.
   */
  if (isPrismaKnownRequestError(err)) {
    const code = getPrismaErrorCode(err);

    switch (code) {
      case "P2002": {
        const target = getPrismaErrorTarget(err);

        return AppError.conflict(
          `Duplicate value for field(s): ${
            target.length > 0
              ? target.join(", ")
              : "unknown"
          }`,
        );
      }

      case "P2025":
        return AppError.notFound("Record not found");

      case "P2003":
        return AppError.badRequest(
          "Invalid reference to a related record",
        );

      default:
        return AppError.badRequest(
          `Database request error (${code ?? "UNKNOWN"})`,
        );
    }
  }

  /*
   * Prisma validation error.
   */
  if (isPrismaValidationError(err)) {
    return AppError.badRequest(
      "Invalid data sent to the database layer",
    );
  }

  /*
   * Normal JavaScript Error.
   */
  if (err instanceof Error) {
    /*
     * JWT errors.
     */
    if (err.name === "JsonWebTokenError") {
      return AppError.unauthorized(
        "Invalid authentication token",
      );
    }

    if (err.name === "TokenExpiredError") {
      return AppError.unauthorized(
        "Authentication token has expired",
      );
    }

    /*
     * Multer upload errors.
     */
    if (err.name === "MulterError") {
      return AppError.badRequest(
        `File upload error: ${err.message}`,
      );
    }

    /*
     * Unknown application bug.
     */
    const unknown = new AppError(
      config.isProd
        ? "Something went wrong"
        : err.message,
      500,
    );

    unknown.stack = err.stack;

    return unknown;
  }

  /*
   * Completely unknown thrown value.
   */
  return AppError.internal(
    "An unexpected error occurred",
  );
}

/**
 * Global Express error handler.
 */
export const globalErrorHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  const error = normalizeError(err);

  const logPayload = {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    statusCode: error.statusCode,
    userId: (
      req as Request & {
        user?: {
          id?: string;
        };
      }
    ).user?.id,
  };

  /*
   * Server errors.
   */
  if (error.statusCode >= 500) {
    logger.error(error.message, {
      ...logPayload,
      stack: error.stack,
      details: error.details,
    });

    void recordErrorLog({
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
  } else {
    /*
     * Client errors.
     */
    logger.warn(error.message, logPayload);
  }

  /*
   * Standard API error response.
   */
  const body: ErrorResponseBody = {
    success: false,
    status: error.status,
    message: error.message,
  };

  if (error.details) {
    body.errors = error.details;
  }

  if (config.isDev) {
    body.stack = error.stack;
  }

  res
    .status(error.statusCode)
    .json(body);
};

/**
 * Catches synchronous throws that happen outside
 * the Express request lifecycle and unhandled
 * promise rejections.
 */
export const registerProcessErrorHandlers = () => {
  /*
   * Uncaught exceptions.
   */
  process.on(
    "uncaughtException",
    (err: Error) => {
      logger.error(
        "UNCAUGHT EXCEPTION — shutting down",
        {
          message: err.message,
          stack: err.stack,
        },
      );

      process.exit(1);
    },
  );

  /*
   * Unhandled promise rejections.
   */
  process.on(
    "unhandledRejection",
    (reason: unknown) => {
      const message =
        reason instanceof Error
          ? reason.message
          : String(reason);

      const stack =
        reason instanceof Error
          ? reason.stack
          : undefined;

      logger.error(
        "UNHANDLED PROMISE REJECTION — shutting down",
        {
          message,
          stack,
        },
      );

      process.exit(1);
    },
  );
};