import { Router } from 'express';
import * as tileRecommendationController from '@controllers/tileRecommendation.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { tileRecommendationsQuerySchema } from '@validators/tileRecommendation.validators';

const router = Router();

router.use(authenticate);

router.get('/recommendations', requirePermission('tiles:read'), validate(tileRecommendationsQuerySchema, 'query'), tileRecommendationController.getRecommendations);

export default router;
