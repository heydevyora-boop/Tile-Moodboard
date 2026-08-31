import dotenv from 'dotenv';
import path from 'path';
import { z } from 'zod';

// ============================================================
// LOAD ENVIRONMENT FILE
// ============================================================

// Load the correct .env file.
// NODE_ENV must be set by the process manager or defaults
// to "development" locally.

const envFile =
  process.env.NODE_ENV === 'production'
    ? '.env'
    : `.env.${process.env.NODE_ENV || 'development'}`;

dotenv.config({
  path: path.resolve(
    process.cwd(),
    envFile,
  ),
});

// Fallback to plain .env if the env-specific
// file doesn't exist.

dotenv.config({
  path: path.resolve(
    process.cwd(),
    '.env',
  ),
});

console.log(
  `[env.ts] cwd=${process.cwd()} ` +
    `envFile=${envFile} ` +
    `raw CATALOG_MAX_UPLOAD_MB=${JSON.stringify(process.env.CATALOG_MAX_UPLOAD_MB)}`,
);

// ============================================================
// ABSOLUTE PATH HELPER
// ============================================================

const absolutePath = (
  ...defaultSegments: string[]
) =>
  z
    .string()
    .default(
      path.resolve(
        process.cwd(),
        ...defaultSegments,
      ),
    )
    .transform((v) =>
      path.resolve(
        process.cwd(),
        v,
      ),
    );

// ============================================================
// ENVIRONMENT SCHEMA
// ============================================================

const envSchema = z.object({

  // ==========================================================
  // CORE
  // ==========================================================

  NODE_ENV: z
    .enum([
      'development',
      'test',
      'production',
    ])
    .default('development'),

  PORT: z
    .coerce
    .number()
    .int()
    .positive()
    .default(5000),

  APP_NAME: z
    .string()
    .default(
      'Casa de Aurum Internal Tool',
    ),

  API_PREFIX: z
    .string()
    .default('/api/v1'),

  // ==========================================================
  // BACKEND
  // ==========================================================

  BACKEND_PUBLIC_URL: z
    .string()
    .url()
    .default(
      'http://localhost:5000',
    ),

  // ==========================================================
  // DATABASE
  // ==========================================================

  DATABASE_URL: z
    .string()
    .min(
      1,
      'DATABASE_URL is required',
    ),

  // ==========================================================
  // AUTH
  // ==========================================================

  // JWT_SECRET signs short-lived access tokens.

  JWT_SECRET: z
    .string()
    .min(
      16,
      'JWT_SECRET must be at least 16 characters',
    ),

  ENCRYPTION_KEY: z
    .string()
    .optional()
    .transform(
      (v) =>
        v === ''
          ? undefined
          : v,
    )
    .refine(
      (v) =>
        v === undefined ||
        v.length >= 16,
      {
        message:
          'ENCRYPTION_KEY must be at least 16 characters',
      },
    ),

  JWT_EXPIRES_IN: z
    .string()
    .default('15m'),

  JWT_REFRESH_SECRET: z
    .string()
    .min(
      16,
      'JWT_REFRESH_SECRET must be at least 16 characters',
    ),

  JWT_REFRESH_EXPIRES_IN: z
    .string()
    .default('30d'),

  PASSWORD_RESET_EXPIRES_IN: z
    .string()
    .default('1h'),

  BCRYPT_SALT_ROUNDS: z
    .coerce
    .number()
    .int()
    .min(10)
    .max(15)
    .default(12),

  // ==========================================================
  // FRONTEND
  // ==========================================================

  FRONTEND_URL: z
    .string()
    .default(
      'http://localhost:3000',
    ),

  PASSWORD_RESET_PATH: z
    .string()
    .default(
      '/reset-password',
    ),

  // ==========================================================
  // CORS
  // ==========================================================

  CORS_ORIGINS: z
    .string()
    .default(
      'http://localhost:3000',
    ),

  // ==========================================================
  // RATE LIMITING
  // ==========================================================

  RATE_LIMIT_WINDOW_MS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(
      15 * 60 * 1000,
    ),

  RATE_LIMIT_MAX: z
    .coerce
    .number()
    .int()
    .positive()
    .default(300),

  // ==========================================================
  // GOOGLE INTEGRATION
  // ==========================================================

  GOOGLE_SERVICE_ACCOUNT_KEY_PATH:
    z.string().optional(),

  GOOGLE_SHEET_NAME: z
    .string()
    .default(
      'CasaDeAurum Tiles',
    ),

  GOOGLE_DRIVE_ROOT_FOLDER: z
    .string()
    .default(
      'CasaDeAurum',
    ),

  // ==========================================================
  // GEMINI AI
  // ==========================================================

  GEMINI_API_KEY:
    z.string().optional(),

  GEMINI_MODEL: z
    .string()
    .default(
      'gemini-2.5-flash',
    ),

  GEMINI_TIMEOUT_MS: z
    .coerce
    .number()
    .int()
    .positive()
    .default(30_000),

  GEMINI_MAX_RETRIES: z
    .coerce
    .number()
    .int()
    .min(0)
    .max(10)
    .default(3),

  GEMINI_RETRY_BASE_DELAY_MS:
    z
      .coerce
      .number()
      .int()
      .positive()
      .default(1_000),

  GEMINI_TEMPERATURE: z
    .coerce
    .number()
    .min(0)
    .max(2)
    .default(0.7),

  GEMINI_MAX_OUTPUT_TOKENS:
    z
      .coerce
      .number()
      .int()
      .positive()
      .default(2048),

  // ==========================================================
  // PYTHON BRIDGE
  // ==========================================================

  PYTHON_EXECUTABLE: z
    .string()
    .default('python3'),

  PYTHON_SCRIPTS_DIR:
    absolutePath('python'),

  // ==========================================================
  // PYTHON AI SERVICE
  // ==========================================================

  PYTHON_AI_BASE_URL: z
    .string()
    .url()
    .default(
      'http://127.0.0.1:8000',
    ),

  // ==========================================================
  // CATALOG
  // ==========================================================

  CATALOG_UPLOADS_DIR:
    absolutePath(
      'uploads',
      'catalogs',
    ),

  CATALOG_EXTRACTED_DIR:
    absolutePath(
      'uploads',
      'extracted-images',
    ),

  CATALOG_MAX_UPLOAD_MB:
    z
      .coerce
      .number()
      .int()
      .positive()
      .default(300),

  CATALOG_EXTRACTION_CONCURRENCY:
    z
      .coerce
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2),

  // ==========================================================
  // REFERENCE IMAGES
  // ==========================================================

  REFERENCE_IMAGES_DIR:
    absolutePath(
      'uploads',
      'reference-images',
    ),

  REFERENCE_IMAGE_MAX_MB:
    z
      .coerce
      .number()
      .int()
      .positive()
      .default(10),

  // ==========================================================
  // PRINT BOARDS
  // ==========================================================

  PRINT_BOARDS_DIR:
    absolutePath(
      'uploads',
      'print-boards',
    ),

  // ==========================================================
  // LOGGING
  // ==========================================================

  LOG_LEVEL: z
    .enum([
      'error',
      'warn',
      'info',
      'http',
      'debug',
    ])
    .default('info'),

  LOG_DIR:
    absolutePath('logs'),
});

// ============================================================
// ENV TYPE
// ============================================================

export type Env =
  z.infer<typeof envSchema>;

// ============================================================
// LOAD + VALIDATE ENV
// ============================================================

function loadEnv(): Env {
  const parsed =
    envSchema.safeParse(
      process.env,
    );

  if (!parsed.success) {

    // eslint-disable-next-line no-console
    console.error(
      '\n❌ Invalid environment configuration:\n',
    );

    for (
      const issue of
        parsed.error.issues
    ) {

      // eslint-disable-next-line no-console
      console.error(
        `  • ${issue.path.join('.')} : ${issue.message}`,
      );
    }

    // eslint-disable-next-line no-console
    console.error(
      '\nCheck your .env file against .env.example and try again.\n',
    );

    process.exit(1);
  }

  return parsed.data;
}

// ============================================================
// EXPORTS
// ============================================================

export const env =
  loadEnv();

export const isProd =
  env.NODE_ENV ===
  'production';

export const isDev =
  env.NODE_ENV ===
  'development';

export const isTest =
  env.NODE_ENV ===
  'test';