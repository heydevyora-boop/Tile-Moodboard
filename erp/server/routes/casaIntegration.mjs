import { Router } from 'express';
import { requireCasaKey } from '../middleware/casaAuth.mjs';
import { handler } from '../validate.mjs';
import { getCasaCatalogFeed } from '../services/casaExport.service.mjs';

/* ============================================================
   /api/v1/integrations/casa — THE ONE SURFACE CASA CALLS
   ============================================================
   New, v1-only, exactly like dashboard.mjs and parties.mjs were
   when step 8 added them -- there is no legacy /api equivalent to
   preserve, because nothing before this existed.

   Gated by requireCasaKey (x-casa-key / CASA_INTEGRATION_API_KEY),
   never by the x-erp-user placeholder or requirePermission(): the
   caller here is another SERVICE, not a person at a screen, and a
   shared secret is the whole of its identity. See
   server/middleware/casaAuth.mjs for why that is a separate secret
   from everything else in this file's sibling routes.
   ============================================================ */

const router = Router();

router.use(requireCasaKey);

router.get('/catalog-feed', handler(async (req, res) => {
  const q = req.query;
  res.json(await getCasaCatalogFeed({
    page: Number(q.page) || 1,
    pageSize: Number(q.pageSize) || 50,
    brandId: q.brandId || undefined,
    collectionId: q.collectionId || undefined,
  }));
}));

export default router;
