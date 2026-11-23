import { Router } from 'express';
import * as partyController from '../controllers/party.controller.mjs';

/* ============================================================
   PARTIES — NEW IN STEP 8
   ============================================================
   /api/v1 only, same reason as the dashboard: nothing existed to
   preserve. A thin search surface over customer.service.mjs and
   supplier.service.mjs -- see server/services/party.service.mjs
   for why there is no merged Party model behind it.
   ============================================================ */

const router = Router();

router.get('/parties', partyController.search);
router.get('/parties/:partyType/:id', partyController.get);
router.get('/parties/:partyType/:id/history', partyController.history);

export default router;
