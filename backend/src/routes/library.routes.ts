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
import { AppError } from '@utils/AppError';
import { authenticate, requirePermission } from '@middlewares/auth';
import { uploadReferenceImage } from '@middlewares/uploadReferenceImage';
import * as library from '@services/library.service';
import { THEMES } from '@services/themes.service';

const router = Router();

router.use(authenticate);

/**
 * addReference, with a missing table explained rather than leaked.
 *
 * An upload of ninety pictures against a database that has no table
 * would otherwise report "Database request error (P2021)" ninety times,
 * which names neither the cause nor the cure. addReference's own
 * errors -- a bad theme, a file that is not an image, a Drive refusal
 * -- are already written for a person, so they pass through untouched.
 */
async function addOrExplain(
  ...args: Parameters<typeof library.addReference>
): Promise<Awaited<ReturnType<typeof library.addReference>>> {
  try {
    return await library.addReference(...args);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw AppError.badRequest(library.describeStorageFailure(error));
  }
}

router.get(
  '/themes',
  requirePermission('reference_images:read'),
  catchAsync(async (_req: Request, res: Response) => {
    // THE NINE THEMES DO NOT COME FROM THE DATABASE.
    //
    // They are shared/themes.json. Only the counts beside them need a
    // table -- and on a deployment whose migration has not been run,
    // that one count query was taking the whole endpoint down with it,
    // so the page showed no themes, no way into a theme, and therefore
    // no way to upload anything. The feature looked empty when the only
    // thing actually missing was a number.
    //
    // So the counts are allowed to fail on their own. The themes are
    // always listed, and `storage` says plainly why the counts are
    // absent so the page can show it rather than a shrug.
    let counts: Record<string, number> = {};
    let storageError = '';

    try {
      counts = await library.countByTheme();
    } catch (error) {
      storageError = library.describeStorageFailure(error);
      console.error(`[library] the reference counts could not be read: ${storageError}`);
    }

    const themes = Object.values(THEMES)
      .map((theme) => ({
        id: theme.id,
        label: theme.label,
        // The gallery shows each theme's existing preview art, which is
        // named by slug in frontend/img/themes.
        slug: theme.slug,
        palette: theme.palette,
        // Null, not 0, when the count could not be read. "0 REFERENCES"
        // beside a theme that may well hold forty is a lie the page
        // would have no way to spot.
        count: storageError ? null : (counts[theme.id] ?? 0),
      }))
      // Stable, and the same order the file lists them in.
      .filter((theme, index, all) => all.findIndex((t) => t.id === theme.id) === index);

    res.status(200).json({
      success: true,
      data: {
        themes,
        storage: { ok: !storageError, reason: storageError },
      },
    });
  }),
);

router.get(
  '/references',
  requirePermission('reference_images:read'),
  catchAsync(async (req: Request, res: Response) => {
    const themeId = typeof req.query.themeId === 'string' && req.query.themeId
      ? req.query.themeId
      : undefined;
    // Unlike the theme list, this one genuinely cannot work without the
    // table -- so it fails. What it must not do is fail with Prisma's
    // own "Database request error (P2021)", which says nothing about
    // the one action that fixes it.
    let references;
    try {
      references = await library.listReferences(themeId);
    } catch (error) {
      throw AppError.badRequest(library.describeStorageFailure(error));
    }

    res.status(200).json({ success: true, data: { references } });
  }),
);

router.post(
  '/references',
  requirePermission('reference_images:write'),
  uploadReferenceImage,
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as { themeId?: string; title?: string; room?: string; description?: string };
    const created = await addOrExplain(
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
    let result;
    try {
      result = await library.deleteReference(String(req.params.id), req.user!.id, req);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw AppError.badRequest(library.describeStorageFailure(error));
    }
    res.status(200).json({ success: true, data: result });
  }),
);

export default router;
