"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isTest = exports.isDev = exports.isProd = exports.env = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const zod_1 = require("zod");
const envFile = process.env.NODE_ENV === 'production'
    ? '.env'
    : `.env.${process.env.NODE_ENV || 'development'}`;
dotenv_1.default.config({
    path: path_1.default.resolve(process.cwd(), envFile),
});
dotenv_1.default.config({
    path: path_1.default.resolve(process.cwd(), '.env'),
});
console.log(`[env.ts] cwd=${process.cwd()} ` +
    `envFile=${envFile} ` +
    `raw CATALOG_MAX_UPLOAD_MB=${JSON.stringify(process.env.CATALOG_MAX_UPLOAD_MB)}`);
const absolutePath = (...defaultSegments) => zod_1.z
    .string()
    .default(path_1.default.resolve(process.cwd(), ...defaultSegments))
    .transform((v) => path_1.default.resolve(process.cwd(), v));
const envSchema = zod_1.z.object({
    NODE_ENV: zod_1.z
        .enum([
        'development',
        'test',
        'production',
    ])
        .default('development'),
    PORT: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(5000),
    APP_NAME: zod_1.z
        .string()
        .default('Casa de Aurum Internal Tool'),
    API_PREFIX: zod_1.z
        .string()
        .default('/api/v1'),
    BACKEND_PUBLIC_URL: zod_1.z
        .string()
        .url()
        .default('http://localhost:5000'),
    DATABASE_URL: zod_1.z
        .string()
        .min(1, 'DATABASE_URL is required'),
    JWT_SECRET: zod_1.z
        .string()
        .min(16, 'JWT_SECRET must be at least 16 characters'),
    ENCRYPTION_KEY: zod_1.z
        .string()
        .optional()
        .transform((v) => v === ''
        ? undefined
        : v)
        .refine((v) => v === undefined ||
        v.length >= 16, {
        message: 'ENCRYPTION_KEY must be at least 16 characters',
    }),
    JWT_EXPIRES_IN: zod_1.z
        .string()
        .default('15m'),
    JWT_REFRESH_SECRET: zod_1.z
        .string()
        .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
    JWT_REFRESH_EXPIRES_IN: zod_1.z
        .string()
        .default('30d'),
    PASSWORD_RESET_EXPIRES_IN: zod_1.z
        .string()
        .default('1h'),
    BCRYPT_SALT_ROUNDS: zod_1.z
        .coerce
        .number()
        .int()
        .min(10)
        .max(15)
        .default(12),
    FRONTEND_URL: zod_1.z
        .string()
        .default('http://localhost:3000'),
    PASSWORD_RESET_PATH: zod_1.z
        .string()
        .default('/reset-password'),
    CORS_ORIGINS: zod_1.z
        .string()
        .default('http://localhost:3000'),
    RATE_LIMIT_WINDOW_MS: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(15 * 60 * 1000),
    RATE_LIMIT_MAX: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(300),
    GOOGLE_SERVICE_ACCOUNT_KEY_PATH: zod_1.z.string().optional(),
    GOOGLE_SHEET_NAME: zod_1.z
        .string()
        .default('CasaDeAurum Tiles'),
    GOOGLE_DRIVE_ROOT_FOLDER: zod_1.z
        .string()
        .default('CasaDeAurum'),
    GEMINI_API_KEY: zod_1.z.string().optional(),
    GEMINI_MODEL: zod_1.z
        .string()
        .default('gemini-2.5-flash'),
    GEMINI_TIMEOUT_MS: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(30000),
    GEMINI_MAX_RETRIES: zod_1.z
        .coerce
        .number()
        .int()
        .min(0)
        .max(10)
        .default(3),
    GEMINI_RETRY_BASE_DELAY_MS: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(1000),
    GEMINI_TEMPERATURE: zod_1.z
        .coerce
        .number()
        .min(0)
        .max(2)
        .default(0.7),
    GEMINI_MAX_OUTPUT_TOKENS: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(2048),
    INTERNAL_SYNC_API_KEY: zod_1.z.string().optional(),
    PYTHON_EXECUTABLE: zod_1.z
        .string()
        .default('python3'),
    PYTHON_SCRIPTS_DIR: absolutePath('python'),
    PYTHON_AI_BASE_URL: zod_1.z
        .string()
        .url()
        .default('http://127.0.0.1:8000'),
    CATALOG_UPLOADS_DIR: absolutePath('uploads', 'catalogs'),
    CATALOG_EXTRACTED_DIR: absolutePath('uploads', 'extracted-images'),
    CATALOG_MAX_UPLOAD_MB: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(300),
    CATALOG_EXTRACTION_CONCURRENCY: zod_1.z
        .coerce
        .number()
        .int()
        .min(1)
        .max(10)
        .default(2),
    REFERENCE_IMAGES_DIR: absolutePath('uploads', 'reference-images'),
    REFERENCE_IMAGE_MAX_MB: zod_1.z
        .coerce
        .number()
        .int()
        .positive()
        .default(10),
    PRINT_BOARDS_DIR: absolutePath('uploads', 'print-boards'),
    LOG_LEVEL: zod_1.z
        .enum([
        'error',
        'warn',
        'info',
        'http',
        'debug',
    ])
        .default('info'),
    LOG_DIR: absolutePath('logs'),
});
function loadEnv() {
    const parsed = envSchema.safeParse(process.env);
    if (!parsed.success) {
        console.error('\n❌ Invalid environment configuration:\n');
        for (const issue of parsed.error.issues) {
            console.error(`  • ${issue.path.join('.')} : ${issue.message}`);
        }
        console.error('\nCheck your .env file against .env.example and try again.\n');
        process.exit(1);
    }
    return parsed.data;
}
exports.env = loadEnv();
exports.isProd = exports.env.NODE_ENV ===
    'production';
exports.isDev = exports.env.NODE_ENV ===
    'development';
exports.isTest = exports.env.NODE_ENV ===
    'test';
//# sourceMappingURL=env.js.map