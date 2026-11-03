/**
 * De'vyora Library.
 *
 *   GET    /library/references?themeId=   browse a theme's rooms
 *   GET    /library/themes                the themes, with their counts
 *   POST   /library/references            add ONE picture (multipart)
 *   DELETE /library/references/:id        remove one, from Drive too
 *
 * "Bulk" lives in the browser: the page sends one request per picture, a
 * few at a time. See library.service for why one request cannot carry
 * fifty of them on this deployment.
 *
 * Permissions are the existing reference_images ones rather than new
 * library:* ones. New permissions would have to be added to every role
 * that should have them, and a role seeding mistake locks the owner out
 * of their own feature; these two already mean "may manage reference
 * pictures", which is exactly what this is.
 */

import { Router, Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { authenticate, requirePermission } from '@middlewares/auth';
import { uploadReferenceImage } from '@middlewares/uploadReferenceImage';
import * as library from '@services/library.service';
import { THEMES } from '@services/themes.service';

const router = Router();

router.use(authenticate);

router.get(
  '/themes',
  requirePermission('reference_images:read'),
  catchAsync(async (_req: Request, res: Response) => {
    const counts = await library.countByTheme();
    const themes = Object.values(THEMES)
      .map((theme) => ({
        id: theme.id,
        label: theme.label,
        // The gallery shows each theme's existing preview art, which is
        // named by slug in frontend/img/themes.
        slug: theme.slug,
        palette: theme.palette,
        count: counts[theme.id] ?? 0,
      }))
      // Stable, and the same order the file lists them in.
      .filter((theme, index, all) => all.findIndex((t) => t.id === theme.id) === index);

    res.status(200).json({ success: true, data: { themes } });
  }),
);

router.get(
  '/references',
  requirePermission('reference_images:read'),
  catchAsync(async (req: Request, res: Response) => {
    const themeId = typeof req.query.themeId === 'string' && req.query.themeId
      ? req.query.themeId
      : undefined;
    const references = await library.listReferences(themeId);
    res.status(200).json({ success: true, data: { references } });
  }),
);

router.post(
  '/references',
  requirePermission('reference_images:write'),
  uploadReferenceImage,
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as { themeId?: string; title?: string; room?: string; description?: string };
    const created = await library.addReference(
      req.file,
      {
        themeId: body.themeId,
        title: body.title,
        room: body.room,
        description: body.description,
      },
      req.user!.id,
      req,
    );
    res.status(201).json({ success: true, data: { reference: created } });
  }),
);

router.delete(
  '/references/:id',
  requirePermission('reference_images:write'),
  catchAsync(async (req: Request, res: Response) => {
    const result = await library.deleteReference(String(req.params.id), req.user!.id, req);
    res.status(200).json({ success: true, data: result });
  }),
);

export default router;
