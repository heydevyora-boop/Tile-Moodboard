import { Router } from 'express';

import healthRoutes from './health.routes';
import authRoutes from './auth.routes';
import userRoutes from './user.routes';
import roleRoutes from './role.routes';
import dashboardRoutes from './dashboard.routes';
import catalogExtractorRoutes from './catalogExtractor.routes';
import designRulesRoutes from './designRules.routes';
import referenceImagesRoutes from './referenceImages.routes';
import integrationsRoutes from './integrations.routes';
import moodBoardRoutes from './moodBoard.routes';
import printBoardRoutes from './printBoard.routes';
import tileRecommendationRoutes from './tileRecommendation.routes';
import customerRoutes from './customer.routes';
import apiKeyRoutes from './apiKey.routes';
import adminRoutes from './admin.routes';
import settingsRoutes from './settings.routes';
import jobsRoutes from './jobs.routes';
import aiVisualizationRoutes from './ai_visualization.routes';

const router = Router();

router.use('/health', healthRoutes);
router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/catalog-extractor', catalogExtractorRoutes);
router.use('/design-rules', designRulesRoutes);
router.use('/reference-images', referenceImagesRoutes);
router.use('/integrations', integrationsRoutes);
router.use('/mood-boards', moodBoardRoutes);
router.use('/print-boards', printBoardRoutes);
router.use('/tiles', tileRecommendationRoutes);
router.use('/customers', customerRoutes);
router.use('/admin/api-keys', apiKeyRoutes);
router.use('/admin', adminRoutes);
router.use('/settings', settingsRoutes);
router.use('/jobs', jobsRoutes);

// Python AI visualization service
router.use(
  '/ai',
  aiVisualizationRoutes
);

export default router;