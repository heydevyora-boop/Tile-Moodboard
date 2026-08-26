import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { prisma } from '@db/connection';
import { getRecommendedTiles } from '@services/tileRecommendation.service';
import { TileRecommendationsQuery } from '@validators/tileRecommendation.validators';

export const getRecommendations = catchAsync(async (req: Request, res: Response) => {
  const query = req.query as unknown as TileRecommendationsQuery;
  const tiles = await getRecommendedTiles(prisma, query);
  res.status(200).json({ success: true, data: { tiles } });
});
