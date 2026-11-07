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
      'De’vyora Internal Tool',
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

  // Serverless platforms (Vercel/Lambda) mount the bundle read-only and
  // have nowhere safe to put a key file -- committing one would publish
  // the private key. This holds the same service-account JSON as the file
  // above, pasted into an env var instead. KEY_PATH still takes
  // precedence, so existing Docker/local setups are unaffected.
  GOOGLE_SERVICE_ACCOUNT_JSON:
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

  /*
   * THE DRIVE FOLDER DE'VYORA LIBRARY UPLOADS INTO.
   *
   * The studio's own "Reference Images" folder. Every library picture
   * goes directly inside it -- never into the Drive root, and never
   * into a sub-folder this code invents.
   *
   * A LINK OR AN ID. Google shows a folder as
   * https://drive.google.com/drive/folders/<id>, which is what the
   * right-click "Copy link" puts on the clipboard, so that is accepted
   * as readily as the bare id. library.service unwraps it.
   *
   * No default on purpose. Falling back to the root folder would be
   * exactly the behaviour this setting exists to stop, and it would do
   * it silently; unset, the library refuses to upload and says which
   * variable to set.
   */
  GOOGLE_DRIVE_LIBRARY_FOLDER: z
    .string()
    .optional(),

  /*
   * The same setting under the name the folder itself has. Accepted so
   * that whichever of the two names gets typed into the environment,
   * the pictures land in the right place -- a mismatch here would mean
   * uploads silently going somewhere else, which is the one outcome
   * worth two lines of code to prevent.
   */
  GOOGLE_DRIVE_REFERENCE_IMAGES_FOLDER: z
    .string()
    .optional(),

  /*
   * THE USER A SERVICE ACCOUNT ACTS AS, when it has to write into a
   * person's own My Drive.
   *
   * A service account owns no Drive storage at all. Sharing a My Drive
   * folder with it as an Editor does not change that: the file it
   * creates would be owned by the service account, and Google refuses
   * with "Service Accounts do not have storage quota". There are
   * exactly two configurations that work, and Google's own error names
   * both -- a shared drive, or OAuth delegation. This is the second.
   *
   * Set it to a Workspace mailbox on the same domain (the studio's own
   * address) AND grant the service account domain-wide delegation for
   * https://www.googleapis.com/auth/drive in the Admin console. The
   * service account then acts as that person: the files it uploads are
   * owned by them and count against their storage, exactly as if they
   * had dragged them in.
   *
   * Unset -- the default, and the only possibility on a personal Gmail
   * account -- the service account acts as itself, and the library's
   * folder must live on a shared drive.
   */
  GOOGLE_DRIVE_IMPERSONATE_USER: z
    .string()
    .optional(),

  /*
   * ==========================================================
   * GOOGLE OAUTH -- the studio's own Gmail, for Drive
   * ==========================================================
   *
   * The way a PERSONAL Google account can hold the library's pictures.
   * A service account owns no Drive storage and a personal account has
   * no shared drives and no domain-wide delegation to grant, so the
   * only remaining configuration is the owner authorizing the app once
   * and the app acting as them afterwards. See googleOAuth.service.ts.
   *
   * A "Web application" OAuth client in the Google Cloud console. Its
   * Authorized redirect URI must be, character for character,
   *   <BACKEND_PUBLIC_URL>/api/v1/integrations/google/callback
   */
  GOOGLE_OAUTH_CLIENT_ID:
    z.string().optional(),

  GOOGLE_OAUTH_CLIENT_SECRET:
    z.string().optional(),

  /*
   * Only when the callback cannot be derived from BACKEND_PUBLIC_URL --
   * a preview deployment, a tunnel. It must match the console exactly.
   */
  GOOGLE_OAUTH_REDIRECT_URI:
    z.string().optional(),

  /*
   * WHICH SCOPE, and what it costs.
   *
   *   drive.file (the default) is not a sensitive scope: no Google
   *   verification, no security assessment, and a published app's
   *   refresh token does not expire. It reaches only what the app
   *   created or what the owner handed it through the Google Picker,
   *   which is why there is a Picker step for the one folder that
   *   already exists.
   *
   *   https://www.googleapis.com/auth/drive reaches the existing
   *   folder with no Picker step, but it is a RESTRICTED scope: the
   *   consent screen warns that the app is unverified, and Google may
   *   require a CASA security assessment to verify it.
   */
  GOOGLE_OAUTH_SCOPE: z
    .string()
    .default(
      'https://www.googleapis.com/auth/drive.file',
    ),

  /*
   * A refresh token kept in the environment instead of the database.
   * The database copy, written when the owner connects, wins. This is
   * for a deployment that would rather not store it there at all.
   */
  GOOGLE_OAUTH_REFRESH_TOKEN:
    z.string().optional(),

  /*
   * The browser API key the Google Picker needs (Cloud console ->
   * Credentials -> API key, restricted to the Picker API and to this
   * site's HTTP referrer). It is not a secret -- it is sent to the
   * browser by design -- but it is only handed to the owner's page.
   */
  GOOGLE_PICKER_API_KEY:
    z.string().optional(),

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
  // INTERNAL SERVICE-TO-SERVICE AUTH
  // ==========================================================

  // Shared secret the Python catalog_processor presents (as the
  // x-internal-key header) on the internal /master-sync route, which
  // has no user session to authenticate against. Optional so an
  // existing .env still boots; when unset the route refuses every
  // request rather than running unauthenticated (see internalAuth.ts).

  INTERNAL_SYNC_API_KEY:
    z.string().optional(),

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

  // Vercel injects this automatically once a Blob store is connected to
  // the project. Set, reference images are stored there and the recorded
  // imageUrl is a public https URL the Python service can fetch directly;
  // a serverless host keeps no disk of its own, so an uploaded file had
  // nowhere durable to live. Unset (local/Docker), storage is unchanged.
  BLOB_READ_WRITE_TOKEN:
    z.string().optional(),

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

  // ==========================================================
  // TEMPORARY DEVELOPMENT LOGIN
  // ==========================================================
  //
  // A short username and a weak password, for local work and for a
  // protected testing environment. Declared here because nothing
  // outside this file reads process.env, and OPTIONAL because the
  // normal state of this application is not to have one.
  //
  // These three values do nothing on their own. config/index.ts
  // refuses to expose them when NODE_ENV is production, so setting
  // them on a public deployment has no effect -- see the comment
  // there, which is where the guarantee actually lives.

  DEV_LOGIN_USERNAME: z
    .string()
    .trim()
    .min(1)
    .optional(),

  DEV_LOGIN_PASSWORD: z
    .string()
    .min(1)
    .optional(),

  DEV_LOGIN_EMAIL: z
    .string()
    .email()
    .optional(),

  DEV_LOGIN_ROLE: z
    .string()
    .default('OWNER'),
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