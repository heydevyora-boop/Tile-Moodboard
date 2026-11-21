import express from 'express';
import cors from 'cors';
import { AppError } from './errors.mjs';
import brands from './routes/brands.mjs';
import productHeads from './routes/productHeads.mjs';
import products from './routes/products.mjs';
import reference from './routes/reference.mjs';

/* ============================================================
   THE ERP PRODUCT MASTER API
   ============================================================
       ERP frontend -> THIS -> ERP PostgreSQL

   One step of the chain and no more. There is no call out to the
   Casa De Aurum backend from here, no website client and no
   credentials for one: that is a later phase, and the outbox
   table from step 2 is where it will read its work from.
   ============================================================ */

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
      res.json({ ok: true, database: row.db, phase: 'step-3 product master' });
    } catch (err) { next(err); }
  });

  app.use('/api/brands', brands);
  app.use('/api/product-heads', productHeads);
  app.use('/api/products', products);
  app.use('/api/reference', reference);

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
    console.error('[erp-api] unhandled:', err);
    return res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. The details are in the server log.' },
    });
  });

  return app;
}
