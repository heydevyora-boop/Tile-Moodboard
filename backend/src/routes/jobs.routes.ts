import { Router } from 'express';
import * as jobsController from '@controllers/jobs.controller';
import { authenticate } from '@middlewares/auth';

const router = Router();

router.use(authenticate);
router.get('/:id', jobsController.getJob);

export default router;
