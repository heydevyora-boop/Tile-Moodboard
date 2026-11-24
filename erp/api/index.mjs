/* ============================================================
   VERCEL SERVERLESS ENTRY — THE ERP'S OWN DEPLOYMENT, NOT CASA'S
   ============================================================

   This is a SEPARATE Vercel project from the Casa De Aurum website
   (that project's root vercel.json, at the repository root, is not
   touched by this file or by erp/vercel.json). A Vercel project
   created with "Root Directory" set to `erp` builds and deploys
   only this folder.

   server/index.mjs is the process entry point for local dev (it
   opens a listening socket on 127.0.0.1). On Vercel there is no
   long-lived process -- each request invokes this function, so the
   same createApp() wiring is reused and handed the request/response
   directly instead of calling app.listen().

   Lazy-loaded, the same way backend/api/index.ts does it: if
   createApp() or its first database read throws (most likely a
   missing ERP_DATABASE_URL), Vercel's own opaque
   "FUNCTION_INVOCATION_FAILED" page would otherwise hide the real
   reason. Loading inside the handler's try/catch means the actual
   error reaches the response as JSON instead.
   ============================================================ */

let appPromise = null;

async function loadApp() {
  if (!appPromise) {
    appPromise = import('../server/app.mjs').then(({ createApp }) => createApp());
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await loadApp();
    app(req, res);
  } catch (err) {
    appPromise = null; // let the next request try again rather than cache a permanent failure
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      success: false,
      code: 'STARTUP_FAILED',
      message: 'The ERP API failed to start: ' + err.message,
    }));
  }
}
