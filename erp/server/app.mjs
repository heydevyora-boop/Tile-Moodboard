import express from 'express';
import cors from 'cors';
import { errorEnvelope } from './utils/response.mjs';
import brands from './routes/brands.mjs';
import productHeads from './routes/productHeads.mjs';
import products from './routes/products.mjs';
import reference from './routes/reference.mjs';
import imports from './routes/imports.mjs';
import inventory from './routes/inventory.mjs';
import warehouses from './routes/warehouses.mjs';
import purchase from './routes/purchase.mjs';
import sales from './routes/sales.mjs';
import v1 from './routes/v1.mjs';

/* ============================================================
   THE ERP PRODUCT MASTER API
   ============================================================
       ERP frontend -> THIS -> ERP PostgreSQL

   One step of the chain and no more. There is no call out to the
   Casa De Aurum backend from here, no website client and no
   credentials for one: that is a later phase, and the outbox
   table from step 2 is where it will read its work from.
   ============================================================ */

/* True once this request has been inside the /api/v1 router (set
   by markApiVersion), or for one that never matched anything
   inside it at all -- the 404 and error handlers both run OUTSIDE
   that router, so req.path (the full, unstripped path here) is
   the fallback that still gets a request to /api/v1/nonsense the
   right envelope. */
function isV1(req) {
  return req.apiVersion === 'v1' || req.path.startsWith('/api/v1');
}

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '1mb' }));

  /* The Vite dev server runs on another port, so the browser
     treats the API as cross-origin. Allowed for localhost only,
     and the list is explicit rather than a reflected origin: a
     wildcard here is how an internal API ends up callable from
     any page the studio happens to have open. */
  app.use(cors({
    origin: [
      'http://127.0.0.1:5174', 'http://localhost:5174',
      'http://127.0.0.1:4173', 'http://localhost:4173',
    ],
    credentials: true,
  }));

  /* WHO IS ASKING.
     A placeholder, and labelled as one. Real sign-in is not part
     of step 3, and pretending otherwise would be worse than this:
     the services all take an actor and write it to the audit log,
     so when authentication is built it replaces this middleware
     and nothing downstream changes.

     It resolves a REAL user from the database rather than
     inventing an id, so every audit row points at an account that
     exists. */
  app.use(async (req, _res, next) => {
    try {
      const { prisma } = await import('../db/client.mjs');
      const email = req.header('x-erp-user') || 'admin@devyora.local';
      req.actor = await prisma.user.findUnique({
        where: { email },
        select: { id: true, name: true, email: true },
      });
      next();
    } catch (err) { next(err); }
  });

  app.get(['/api/health', '/api/v1/health'], async (req, res, next) => {
    try {
      const { prisma } = await import('../db/client.mjs');
      const [row] = await prisma.$queryRaw`SELECT current_database() AS db`;
      const payload = { ok: true, database: row.db, phase: 'step-8 ERP API development' };
      if (req.path.startsWith('/api/v1')) {
        return res.json({ success: true, message: 'ERP API is reachable', data: payload, meta: {} });
      }
      res.json(payload);
    } catch (err) { next(err); }
  });

  app.use('/api/brands', brands);
  app.use('/api/product-heads', productHeads);
  app.use('/api/products', products);
  app.use('/api/reference', reference);
  app.use('/api/imports', imports);
  app.use('/api/inventory', inventory);
  app.use('/api/warehouses', warehouses);
  /* Mounted at the root of /api rather than under /api/purchase,
     because the module's documents are peers: suppliers, purchase
     orders, goods receipts, returns and supplier invoices are
     five things, not five views of one. */
  app.use('/api', purchase);
  /* Same reasoning as purchase: customers, quotations, sales
     orders, reservations, dispatches, invoices, returns and
     payments are peer documents, not sub-resources of one noun. */
  app.use('/api', sales);

  /* THE STANDARDIZED SURFACE. Every module above, again, under
     the SAME router objects, plus the two modules step 8 adds
     outright (dashboard, parties). See server/routes/v1.mjs and
     server/utils/response.mjs for what actually differs. */
  app.use('/api/v1', v1);

  app.use((req, res) => {
    const message = 'No such endpoint: ' + req.method + ' ' + req.path;
    res.status(404);
    if (isV1(req)) {
      const send = res.locals.sendRaw ?? res.json.bind(res);
      return send({ success: false, message, code: 'NOT_FOUND', errors: [] });
    }
    res.json({ error: { code: 'NOT_FOUND', message } });
  });

  /* ONE PLACE WHERE ERRORS BECOME RESPONSES, for both API
     generations. errorEnvelope() (server/utils/response.mjs)
     computes the legacy {error:{...}} shape and the v1
     {success:false,...} shape from the SAME error every time, so
     there is exactly one place either shape is assembled -- not
     one here and a second copy for v1. Known errors keep their
     status and their field list in both. Anything else is a 500
     with a generic message in both: a Prisma error carries table
     and column names, and none of that belongs in a browser
     response, logged in full here instead, where it is useful and
     private. */
  app.use((err, req, res, _next) => {
    const { status, legacy, v1: v1Body } = errorEnvelope(err);
    if (status === 500) console.error('[erp-api] unhandled:', err);
    res.status(status);
    if (isV1(req)) {
      const send = res.locals.sendRaw ?? res.json.bind(res);
      return send(v1Body);
    }
    res.json(legacy);
  });

  return app;
}
