import { Router } from 'express';
import { markApiVersion, translateLegacyQueryParams, wrapJsonEnvelope } from '../middleware/apiV1.mjs';

import brands from './brands.mjs';
import productHeads from './productHeads.mjs';
import productLines from './productLines.mjs';
import products from './products.mjs';
import reference from './reference.mjs';
import imports from './imports.mjs';
import inventory from './inventory.mjs';
import warehouses from './warehouses.mjs';
import purchase from './purchase.mjs';
import sales from './sales.mjs';
import dashboard from './dashboard.mjs';
import parties from './parties.mjs';

/* ============================================================
   /api/v1 — THE STANDARDIZED SURFACE
   ============================================================
   Every module /api already had is mounted again here, under the
   SAME router objects brands.mjs, products.mjs, purchase.mjs and
   the rest already export -- not a rewritten copy of a single
   route. Express routers carry no state tied to where they are
   mounted, so reusing them at a second path changes nothing about
   how a request inside them is handled; only what wraps the
   request and the response differs, via the three middlewares
   below (see server/middleware/apiV1.mjs):

     - every response gets the brief's {success,message,data,meta}
       envelope, built structurally from whatever the route
       already returns -- no route file changes;
     - ?limit= is accepted as the brief's own name for the
       pageSize every route already reads;
     - the one error middleware in app.mjs is told which envelope
       to send back, so a thrown error downstream (inside any of
       these same, unmodified route files) comes back in the v1
       shape too.

   dashboard.mjs and parties.mjs are the two modules step 8 adds
   outright; they have no legacy counterpart and so exist only
   here, built with the full routes/controllers/validators split
   the brief asks for on anything genuinely new.
   ============================================================ */

const router = Router();

router.use(markApiVersion);
router.use(translateLegacyQueryParams);
router.use(wrapJsonEnvelope);

router.use('/brands', brands);
router.use('/product-heads', productHeads);
router.use('/product-lines', productLines);
router.use('/products', products);
router.use('/reference', reference);
router.use('/imports', imports);
router.use('/inventory', inventory);
router.use('/warehouses', warehouses);
router.use('/', purchase);
router.use('/', sales);
router.use('/', dashboard);
router.use('/', parties);

export default router;
