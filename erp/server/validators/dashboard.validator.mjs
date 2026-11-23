import { z } from 'zod';

/* ============================================================
   DASHBOARD VALIDATION
   ============================================================
   One query, two optional bounds -- there is nothing to validate
   in a body, because this module writes nothing. Kept as its own
   file, the way the brief's routes/controllers/validators split
   asks for on a module built fresh for this step, rather than
   inlined into the controller.
   ============================================================ */

export const DashboardQuery = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});
