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
  moodBoardTileLookupQuerySchema,
} from '@validators/moodBoard.validators';

const router = Router();

router.use(authenticate);

// Stateless — calls Gemini, returns combinations, never touches the DB (Module 13).
router.post('/generate', requirePermission('mood_boards:write'), moodBoardGenerationRateLimiter, validate(generateBriefSchema), moodBoardController.generate);

// Persistence + review workflow (Module 14).
router.get('/', requirePermission('mood_boards:read'), validate(listMoodBoardsQuerySchema, 'query'), moodBoardController.list);
router.post('/', requirePermission('mood_boards:write'), validate(saveMoodBoardSchema), moodBoardController.save);

// Static path — must come before the "/:id" catch-all below, or Express
// would try to look up a mood board with id "tiles". Resolves the tileId
// references inside a /generate response so the wizard can render them
// (image/size/finish/stock) before a board is ever saved.
router.get('/tiles', requirePermission('tiles:read'), validate(moodBoardTileLookupQuerySchema, 'query'), moodBoardController.getTiles);

router.get('/:id', requirePermission('mood_boards:read'), moodBoardController.getOne);
router.patch('/:id', requirePermission('mood_boards:write'), validate(updateMoodBoardSchema), moodBoardController.update);
router.delete('/:id', requirePermission('mood_boards:write'), moodBoardController.remove);
router.post('/:id/approve', requirePermission('mood_boards:write'), validate(approveMoodBoardSchema), moodBoardController.approve);

export default router;
