import { Router } from 'express';
import * as tileRecommendationController from '@controllers/tileRecommendation.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { tileRecommendationsQuerySchema, listTilesQuerySchema } from '@validators/tileRecommendation.validators';

const router = Router();

router.use(authenticate);

// Static path — must come before "/" below only matters if a param route
// existed; there isn't one here, but recommendations is kept first to read
// as the primary/most-specific use of this router.
router.get('/recommendations', requirePermission('tiles:read'), validate(tileRecommendationsQuerySchema, 'query'), tileRecommendationController.getRecommendations);

// The floor-module sizes the catalog stocks, for the wizard's Custom
// size dropdown. Static path, so it is kept above '/' with the other
// named routes.
router.get('/sizes', requirePermission('tiles:read'), tileRecommendationController.listTileSizes);

// Plain paginated/searchable tile browse for the Catalog page's Surface Archive.
router.get('/', requirePermission('tiles:read'), validate(listTilesQuerySchema, 'query'), tileRecommendationController.listTiles);

export default router;
