import { Router } from 'express';
import * as moodBoardController from '@controllers/moodBoard.controller';
import { authenticate, requirePermission } from '@middlewares/auth';
import { validate } from '@middlewares/validate';
import { moodBoardGenerationRateLimiter } from '@middlewares/rateLimiters';
import {
  generateBriefSchema,
  saveMoodBoardSchema,
  updateMoodBoardSchema,
  approveMoodBoardSchema,
  listMoodBoardsQuerySchema,
} from '@validators/moodBoard.validators';

const router = Router();

router.use(authenticate);

// Stateless — calls Gemini, returns combinations, never touches the DB (Module 13).
router.post('/generate', requirePermission('mood_boards:write'), moodBoardGenerationRateLimiter, validate(generateBriefSchema), moodBoardController.generate);

// Persistence + review workflow (Module 14).
router.get('/', requirePermission('mood_boards:read'), validate(listMoodBoardsQuerySchema, 'query'), moodBoardController.list);
router.post('/', requirePermission('mood_boards:write'), validate(saveMoodBoardSchema), moodBoardController.save);
router.get('/:id', requirePermission('mood_boards:read'), moodBoardController.getOne);
router.patch('/:id', requirePermission('mood_boards:write'), validate(updateMoodBoardSchema), moodBoardController.update);
router.delete('/:id', requirePermission('mood_boards:write'), moodBoardController.remove);
router.post('/:id/approve', requirePermission('mood_boards:write'), validate(approveMoodBoardSchema), moodBoardController.approve);

export default router;
