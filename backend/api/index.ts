// Vercel serverless entry point for the Express backend.
//
// server.ts is the process entry point for Docker/PM2 (it opens a
// listening HTTP socket). On Vercel there is no long-lived process --
// each request invokes this function, so we reuse the same createApp()
// wiring but hand the request/response straight to Express instead of
// calling server.listen().
import 'tsconfig-paths/register';
import '@prisma/client';

import { createApp } from '../src/app';
import { connectDatabase } from '../src/db/connection';

const app = createApp();

// Serverless functions may reuse a warm instance across invocations, so
// cache the connection promise instead of reconnecting on every request.
let dbReady: Promise<void> | null = null;

export default async function handler(req: any, res: any) {
  if (!dbReady) {
    dbReady = connectDatabase();
  }
  await dbReady;

  return app(req, res);
}
