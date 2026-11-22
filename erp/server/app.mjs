import express from 'express';
import cors from 'cors';
import { AppError } from './errors.mjs';
import brands from './routes/brands.mjs';
import productHeads from './routes/productHeads.mjs';
import products from './routes/products.mjs';
import reference from './routes/reference.mjs';
import imports from './routes/imports.mjs';
import inventory from './routes/inventory.mjs';
import warehouses from './routes/warehouses.mjs';
import purchase from './routes/purchase.mjs';

/* ============================================================
   THE ERP PRODUCT MASTER API
   ============================================================
       ERP frontend -> THIS -> ERP PostgreSQL

   One step of the chain and no more. There is no call out to the
   Casa De Aurum backend from here, no website client and no
   credentials for one: that is a later phase, and the outbox
   table from step 2 is where it will read its work from.
   ============================================================ */

/* Which stock-layer errors are answers rather than faults, and
   what each one tells the caller. */
const STOCK_REFUSALS = {
  // Already posted. The caller's idempotency key did its job.
  DuplicateMovementError: (e) => ({
    idempotencyKey: e.idempotencyKey,
    resolution: 'This movement is already on the ledger. Nothing further was posted.',
  }),
  // Refused because it would take a balance below zero. The
  // figures are included so the screen can say "8 available, 12
  // requested" instead of "failed".
  InsufficientStockError: (e) => ({
    dimension: e.dimension,
    available: e.available,
    requested: e.requested,
  }),
  StockValidationError: (e) => ({ fields: e.fields }),
};

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

  app.get('/api/health', async (_req, res, next) => {
    try {
      const { prisma } = await import('../db/client.mjs');
      const [row] = await prisma.$queryRaw`SELECT current_database() AS db`;
      res.json({ ok: true, database: row.db, phase: 'step-6 purchase management' });
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

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint: ' + req.method + ' ' + req.path } });
  });

  /* ONE PLACE WHERE ERRORS BECOME RESPONSES.
     Known errors keep their status and their field list. Anything
     else is a 500 with a generic message: a Prisma error carries
     table names, column names and sometimes values, and none of
     that belongs in a browser. It is logged in full on the
     server, where it is useful and private. */
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }

    /* THE STOCK SERVICE'S OWN REFUSALS.
       db/stock.mjs is the database layer and knows nothing about
       HTTP -- deliberately, so it can be called from a script or a
       test with no Express in sight. Its three refusals are
       answers, not faults, and each already states the status and
       the figures behind it. Translated here by name, from a
       closed list: "any error carrying a status" would eventually
       let a Prisma error through, and those carry table names,
       column names and sometimes values.

       Without this, re-submitting a form came back as
       "Something went wrong" with a 500 -- for a request the
       system had handled perfectly, by refusing to post the same
       movement twice. */
    if (STOCK_REFUSALS[err?.name]) {
      return res.status(err.status).json({
        error: {
          code: err.code,
          message: err.message,
          details: STOCK_REFUSALS[err.name](err),
        },
      });
    }
    console.error('[erp-api] unhandled:', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. The details are in the server log.' },
    });
  });

  return app;
}
