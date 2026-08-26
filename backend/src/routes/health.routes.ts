import { Router } from 'express';
import { prisma } from '@db/connection';
import { catchAsync } from '@utils/catchAsync';
import { config } from '@config/index';

const router = Router();

router.get(
  '/',
  catchAsync(async (_req, res) => {
    let dbStatus: 'up' | 'down' = 'up';

    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      dbStatus = 'down';
    }

    const body = {
      success: true,
      app: config.app.name,
      env: config.env,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      db: dbStatus,
    };

    res.status(dbStatus === 'up' ? 200 : 503).json(body);
  }),
);

export default router;
