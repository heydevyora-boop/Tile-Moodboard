import {
  env,
  isDev,
  isProd,
  isTest,
} from './env';

/**
 * Central place every other module imports config from.
 *
 * Never read process.env directly outside of env.ts.
 */

export const config = {
  env: env.NODE_ENV,

  isDev,
  isProd,
  isTest,

  // ============================================================
  // APP
  // ============================================================

  app: {
    name: env.APP_NAME,
    port: env.PORT,
    apiPrefix: env.API_PREFIX,
  },

  // ============================================================
  // DATABASE
  // ============================================================

  db: {
    url: env.DATABASE_URL,
  },

  // ============================================================
  // BACKEND
  // ============================================================

  backend: {
    publicUrl:
      env.BACKEND_PUBLIC_URL,
  },

  // ============================================================
  // AUTH
  // ============================================================

  auth: {
    jwtSecret:
      env.JWT_SECRET,

    jwtExpiresIn:
      env.JWT_EXPIRES_IN,

    jwtRefreshSecret:
      env.JWT_REFRESH_SECRET,

    jwtRefreshExpiresIn:
      env.JWT_REFRESH_EXPIRES_IN,

    passwordResetExpiresIn:
      env.PASSWORD_RESET_EXPIRES_IN,

    bcryptSaltRounds:
      env.BCRYPT_SALT_ROUNDS,

    encryptionKey:
      env.ENCRYPTION_KEY ??
      env.JWT_SECRET,

    refreshCookieName:
      'refreshToken',
  },

  // ============================================================
  // FRONTEND
  // ============================================================

  frontend: {
    url:
      env.FRONTEND_URL,

    passwordResetPath:
      env.PASSWORD_RESET_PATH,
  },

  // ============================================================
  // CORS
  // ============================================================

  cors: {
    origins:
      env.CORS_ORIGINS
        .split(',')
        .map(
          (o) => o.trim(),
        )
        .filter(Boolean),
  },

  // ============================================================
  // RATE LIMIT
  // ============================================================

  rateLimit: {
    windowMs:
      env.RATE_LIMIT_WINDOW_MS,

    max:
      env.RATE_LIMIT_MAX,
  },

  // ============================================================
  // GOOGLE
  // ============================================================

  google: {
    serviceAccountKeyPath:
      env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,

    sheetName:
      env.GOOGLE_SHEET_NAME,

    driveRootFolder:
      env.GOOGLE_DRIVE_ROOT_FOLDER,
  },

  // ============================================================
  // GEMINI
  // ============================================================

  gemini: {
    apiKey:
      env.GEMINI_API_KEY,

    model:
      env.GEMINI_MODEL,

    timeoutMs:
      env.GEMINI_TIMEOUT_MS,

    maxRetries:
      env.GEMINI_MAX_RETRIES,

    retryBaseDelayMs:
      env.GEMINI_RETRY_BASE_DELAY_MS,

    temperature:
      env.GEMINI_TEMPERATURE,

    maxOutputTokens:
      env.GEMINI_MAX_OUTPUT_TOKENS,
  },

  // ============================================================
  // PYTHON
  // ============================================================

  python: {
    executable:
      env.PYTHON_EXECUTABLE,

    scriptsDir:
      env.PYTHON_SCRIPTS_DIR,

    aiBaseUrl:
      env.PYTHON_AI_BASE_URL,
  },

  // ============================================================
  // CATALOG
  // ============================================================

  catalog: {
    uploadsDir:
      env.CATALOG_UPLOADS_DIR,

    extractedDir:
      env.CATALOG_EXTRACTED_DIR,

    maxUploadBytes:
      env.CATALOG_MAX_UPLOAD_MB *
      1024 *
      1024,

    extractionConcurrency:
      env.CATALOG_EXTRACTION_CONCURRENCY,
  },

  // ============================================================
  // REFERENCE IMAGES
  // ============================================================

  referenceImages: {
    uploadsDir:
      env.REFERENCE_IMAGES_DIR,

    maxUploadBytes:
      env.REFERENCE_IMAGE_MAX_MB *
      1024 *
      1024,
  },

  // ============================================================
  // PRINT BOARDS
  // ============================================================

  printBoards: {
    uploadsDir:
      env.PRINT_BOARDS_DIR,
  },

  // ============================================================
  // LOG
  // ============================================================

  log: {
    level:
      env.LOG_LEVEL,

    dir:
      env.LOG_DIR,
  },
} as const;

export { env };