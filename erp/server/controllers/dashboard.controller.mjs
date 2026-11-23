import { parse, handler } from '../validate.mjs';
import { DashboardQuery } from '../validators/dashboard.validator.mjs';
import * as dashboard from '../services/dashboard.service.mjs';

/* ============================================================
   DASHBOARD CONTROLLER
   ============================================================
   HTTP in, HTTP out -- every figure in the response comes from
   dashboard.service.mjs, which itself composes inventory,
   purchase and sales' own existing dashboards rather than
   querying anything a second time. No business logic lives here.
   ============================================================ */

export const getSummary = handler(async (req, res) => {
  const query = parse(DashboardQuery, req.query);
  res.json(await dashboard.summary(query));
});
