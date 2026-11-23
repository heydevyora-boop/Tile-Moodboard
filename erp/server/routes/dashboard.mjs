import { Router } from 'express';
import * as dashboardController from '../controllers/dashboard.controller.mjs';

/* ============================================================
   THE COMBINED DASHBOARD — NEW IN STEP 8
   ============================================================
   /api/v1 only: there is no legacy equivalent to preserve, so
   this is mounted once, not twice like the modules step 8 is
   standardizing. See server/services/dashboard.service.mjs for
   what it actually composes.

   NOT at the bare path `/dashboard` -- purchase.mjs already owns
   that (reused unchanged under v1, see routes/v1.mjs), and it
   answers a narrower question, "how is purchasing doing", that
   its own screen already depends on. `/dashboard/summary` is the
   combined, cross-module one this step adds; `/dashboard`
   (purchase) and `/sales-dashboard` (sales) are unchanged and
   still answer their own module's question exactly as before.
   ============================================================ */

const router = Router();

router.get('/dashboard/summary', dashboardController.getSummary);

export default router;
