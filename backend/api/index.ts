// Vercel serverless entry point for the Express backend.
//
// server.ts is the process entry point for Docker/PM2 (it opens a
// listening HTTP socket). On Vercel there is no long-lived process --
// each request invokes this function, so we reuse the same createApp()
// wiring but hand the request/response straight to Express instead of
// calling server.listen().
import { register } from 'tsconfig-paths';
import * as path from 'path';

// The compiled src/*.js still contain require('@config/...') etc, so the
// tsconfig path aliases have to be registered before anything under src/ is
// loaded. Auto-discovery cannot be used here: it resolves tsconfig.json from
// process.cwd(), which is /var/task on Vercel while the config lives at
// /var/task/backend/tsconfig.json -- registration then silently no-ops and
// every alias fails with "Cannot find module '@config/index'". Passing
// baseUrl/paths explicitly keeps resolution anchored to this file's own
// location and needs no tsconfig.json inside the deployed bundle.
// These entries mirror compilerOptions.paths in backend/tsconfig.json.
register({
  baseUrl: path.resolve(__dirname, '../src'),
  paths: {
    '@config/*': ['config/*'],
    '@db/*': ['db/*'],
    '@middlewares/*': ['middlewares/*'],
    '@utils/*': ['utils/*'],
    '@routes/*': ['routes/*'],
    '@controllers/*': ['controllers/*'],
    '@services/*': ['services/*'],
    '@validators/*': ['validators/*'],
    '@types/*': ['types/*'],
  },
});

// When this function throws while loading its modules, Vercel replaces the
// response with its own opaque page ("A server error has occurred" /
// FUNCTION_INVOCATION_FAILED) and the real cause is only visible in the
// runtime logs. Two failures land there in practice: config/env.ts calls
// process.exit(1) on a validation failure, and an unresolved import throws
// before Express exists. So the app is loaded lazily inside the handler and
// whatever actually went wrong is reported as JSON.

// config/env.ts requires these; everything else in its schema has a default
// or is optional. They are checked here first because process.exit(1) cannot
// be trapped by the try/catch below once that module loads.
const REQUIRED_ENV = [
  'DATABASE_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const SECRETS_WITH_MIN_LENGTH = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
] as const;

const MIN_SECRET_LENGTH = 16;

type ExpressApp = (req: any, res: any) => void;

let app: ExpressApp | null = null;
let dbReady: Promise<void> | null = null;

function assertRequiredEnv(): void {
  const missing = REQUIRED_ENV.filter(
    (key) => !process.env[key],
  );

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variable(s) on the server: ${missing.join(', ')}. ` +
        'Add them in the Vercel project\'s Environment Variables and redeploy.',
    );
  }

  const tooShort = SECRETS_WITH_MIN_LENGTH.filter(
    (key) =>
      (process.env[key] ?? '').length < MIN_SECRET_LENGTH,
  );

  if (tooShort.length > 0) {
    throw new Error(
      `Environment variable(s) shorter than the required ${MIN_SECRET_LENGTH} characters: ` +
        `${tooShort.join(', ')}.`,
    );
  }
}

function loadApp(): ExpressApp {
  if (!app) {
    assertRequiredEnv();

    // Required lazily (a literal path, so dependency tracing still sees it)
    // to keep module-load failures inside the handler's try/catch.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createApp } = require('../src/app');

    app = createApp() as ExpressApp;
  }

  return app;
}

export default async function handler(req: any, res: any) {
  try {
    const expressApp = loadApp();

    // Serverless functions may reuse a warm instance across invocations, so
    // cache the connection promise instead of reconnecting on every request.
    if (!dbReady) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { connectDatabase } = require('../src/db/connection');

      dbReady = connectDatabase() as Promise<void>;
    }

    await dbReady;

    return expressApp(req, res);
  } catch (err) {
    // Let the next invocation retry instead of caching a failed connection.
    dbReady = null;

    res.status(500).json({
      success: false,
      status: 'error',
      message:
        err instanceof Error
          ? err.message
          : String(err),
    });

    return;
  }
}
