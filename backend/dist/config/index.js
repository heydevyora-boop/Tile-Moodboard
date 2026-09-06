"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.env = exports.config = void 0;
const env_1 = require("./env");
Object.defineProperty(exports, "env", { enumerable: true, get: function () { return env_1.env; } });
exports.config = {
    env: env_1.env.NODE_ENV,
    isDev: env_1.isDev,
    isProd: env_1.isProd,
    isTest: env_1.isTest,
    app: {
        name: env_1.env.APP_NAME,
        port: env_1.env.PORT,
        apiPrefix: env_1.env.API_PREFIX,
    },
    db: {
        url: env_1.env.DATABASE_URL,
    },
    backend: {
        publicUrl: env_1.env.BACKEND_PUBLIC_URL,
    },
    auth: {
        jwtSecret: env_1.env.JWT_SECRET,
        jwtExpiresIn: env_1.env.JWT_EXPIRES_IN,
        jwtRefreshSecret: env_1.env.JWT_REFRESH_SECRET,
        jwtRefreshExpiresIn: env_1.env.JWT_REFRESH_EXPIRES_IN,
        passwordResetExpiresIn: env_1.env.PASSWORD_RESET_EXPIRES_IN,
        bcryptSaltRounds: env_1.env.BCRYPT_SALT_ROUNDS,
        encryptionKey: env_1.env.ENCRYPTION_KEY ??
            env_1.env.JWT_SECRET,
        refreshCookieName: 'refreshToken',
    },
    frontend: {
        url: env_1.env.FRONTEND_URL,
        passwordResetPath: env_1.env.PASSWORD_RESET_PATH,
    },
    cors: {
        origins: env_1.env.CORS_ORIGINS
            .split(',')
            .map((o) => o.trim())
            .filter(Boolean),
    },
    rateLimit: {
        windowMs: env_1.env.RATE_LIMIT_WINDOW_MS,
        max: env_1.env.RATE_LIMIT_MAX,
    },
    google: {
        serviceAccountKeyPath: env_1.env.GOOGLE_SERVICE_ACCOUNT_KEY_PATH,
        sheetName: env_1.env.GOOGLE_SHEET_NAME,
        driveRootFolder: env_1.env.GOOGLE_DRIVE_ROOT_FOLDER,
    },
    gemini: {
        apiKey: env_1.env.GEMINI_API_KEY,
        model: env_1.env.GEMINI_MODEL,
        timeoutMs: env_1.env.GEMINI_TIMEOUT_MS,
        maxRetries: env_1.env.GEMINI_MAX_RETRIES,
        retryBaseDelayMs: env_1.env.GEMINI_RETRY_BASE_DELAY_MS,
        temperature: env_1.env.GEMINI_TEMPERATURE,
        maxOutputTokens: env_1.env.GEMINI_MAX_OUTPUT_TOKENS,
    },
    internal: {
        syncApiKey: env_1.env.INTERNAL_SYNC_API_KEY,
    },
    python: {
        executable: env_1.env.PYTHON_EXECUTABLE,
        scriptsDir: env_1.env.PYTHON_SCRIPTS_DIR,
        aiBaseUrl: env_1.env.PYTHON_AI_BASE_URL,
    },
    catalog: {
        uploadsDir: env_1.env.CATALOG_UPLOADS_DIR,
        extractedDir: env_1.env.CATALOG_EXTRACTED_DIR,
        maxUploadBytes: env_1.env.CATALOG_MAX_UPLOAD_MB *
            1024 *
            1024,
        extractionConcurrency: env_1.env.CATALOG_EXTRACTION_CONCURRENCY,
    },
    referenceImages: {
        uploadsDir: env_1.env.REFERENCE_IMAGES_DIR,
        maxUploadBytes: env_1.env.REFERENCE_IMAGE_MAX_MB *
            1024 *
            1024,
    },
    printBoards: {
        uploadsDir: env_1.env.PRINT_BOARDS_DIR,
    },
    log: {
        level: env_1.env.LOG_LEVEL,
        dir: env_1.env.LOG_DIR,
    },
};
//# sourceMappingURL=index.js.map