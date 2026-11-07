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
import { ROOM_LIST, UNSORTED_ROOM } from '@services/rooms.service';
import {
  starterCounts,
  starterRoomCounts,
  startersForTheme,
  asReference,
  isStarterId,
} from '@services/libraryStarters';

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

/**
 * One theme's rooms, with how many pictures each holds.
 *
 * Every room is listed whether or not it holds anything, because an
 * empty Kitchen is a real answer -- "nothing here yet" -- and hiding it
 * would leave the studio with no way to see that a room exists at all,
 * let alone upload into it. The same reasoning as the theme grid, which
 * lists all nine themes however empty.
 *
 * The unsorted bucket appears ONLY when it holds something: it is not a
 * room the studio can choose, just somewhere older pictures sit until
 * they are filed.
 */
function roomBreakdown(
  themeId: string,
  uploaded: Record<string, number>,
): Array<{ id: string; label: string; slug: string; blurb: string; count: number; starterCount: number }> {
  const starters = starterRoomCounts(themeId);

  const rooms = ROOM_LIST.map((room) => ({
    id: room.id,
    label: room.label,
    slug: room.slug,
    blurb: room.blurb,
    count: (uploaded[room.id] ?? 0) + (starters[room.id] ?? 0),
    starterCount: starters[room.id] ?? 0,
  }));

  const orphans = uploaded[UNSORTED_ROOM] ?? 0;
  if (orphans > 0) {
    rooms.push({
      id: UNSORTED_ROOM,
      label: 'Unsorted',
      slug: UNSORTED_ROOM,
      blurb: 'Uploaded before rooms existed, or filed under a name this list does not know.',
      count: orphans,
      starterCount: 0,
    });
  }

  return rooms;
}

// ============================================================
// GET /library/rooms
// ============================================================
// The room types themselves, for the upload form's dropdown. Served
// rather than hard-coded in the page so the page and the server cannot
// disagree about what a room is -- the same reason /themes exists.
router.get(
  '/rooms',
  requirePermission('reference_images:read'),
  catchAsync(async (_req: Request, res: Response) => {
    res.status(200).json({
      success: true,
      data: {
        rooms: ROOM_LIST.map((room) => ({
          id: room.id,
          label: room.label,
          slug: room.slug,
          blurb: room.blurb,
          /** The mood-board wizard's own name, so a choice can pre-select it. */
          wizard: room.wizard,
        })),
      },
    });
  }),
);

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
    let counts: library.LibraryCounts = { byTheme: {}, byRoom: {} };
    let storageError = '';

    try {
      counts = await library.countByTheme();
    } catch (error) {
      storageError = library.describeStorageFailure(error);
      console.error(`[library] the reference counts could not be read: ${storageError}`);
    }

    const starters = starterCounts();

    const themes = Object.values(THEMES)
      .map((theme) => ({
        id: theme.id,
        label: theme.label,
        // The gallery shows each theme's existing preview art, which is
        // named by slug in frontend/img/themes.
        slug: theme.slug,
        palette: theme.palette,
        // The starters count too -- they are rooms a client can open,
        // choose and generate from, so a theme that holds two of them
        // is not an empty theme. And because they need no database,
        // this number is real even when the uploaded ones cannot be
        // counted, which is why it is never null any more.
        count: (storageError ? 0 : (counts.byTheme[theme.id] ?? 0)) + (starters[theme.id] ?? 0),
        /** How many of that count ship with the app. */
        starterCount: starters[theme.id] ?? 0,
        /**
         * THE SECOND LEVEL, counted. roomId -> pictures, uploaded and
         * starter together, so the theme's own screen can show which of
         * its rooms actually hold anything before the client opens one.
         */
        rooms: roomBreakdown(theme.id, storageError ? {} : (counts.byRoom[theme.id] ?? {})),
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
    // THE STARTERS COME FIRST, AND THEY COME WITHOUT A DATABASE.
    //
    // They are files that ship with the application, so a theme always
    // has something in it -- which is the whole point of them. The
    // uploaded rooms are added after, and a database that cannot answer
    // costs only those: the page still shows the starters and says, in
    // `storage`, why the rest are missing.
    //
    // This is the difference from before. This endpoint used to fail
    // outright, so a theme opened to nothing at all.
    const roomId = typeof req.query.roomId === 'string' && req.query.roomId
      ? req.query.roomId
      : undefined;

    const starters = (themeId
      ? startersForTheme(library.resolveThemeId(themeId), roomId)
      : []
    ).map(asReference);

    let uploaded: unknown[] = [];
    let storageError = '';

    try {
      uploaded = await library.listReferences(themeId, roomId);
    } catch (error) {
      storageError = library.describeStorageFailure(error);
    }

    res.status(200).json({
      success: true,
      data: {
        references: [...starters, ...uploaded],
        storage: { ok: !storageError, reason: storageError },
      },
    });
  }),
);

router.post(
  '/references',
  requirePermission('reference_images:write'),
  uploadReferenceImage,
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as {
      themeId?: string; roomId?: string; room?: string; title?: string; description?: string;
    };
    const created = await addOrExplain(
      req.file,
      {
        themeId: body.themeId,
        // `roomId` is what the form sends; `room` is accepted too so an
        // API caller that knows the label rather than the id still
        // files the picture correctly.
        room: body.roomId || body.room,
        title: body.title,
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
    // A starter is part of the application, not of the studio's own
    // library. Saying so beats a confusing "not found" from a lookup
    // that was never going to match a database row.
    if (isStarterId(req.params.id)) {
      throw AppError.badRequest(
        'That is one of the starter rooms that ships with De\u2019vyora, so it cannot be '
        + 'removed from here. Upload the studio\u2019s own rooms and use those instead.',
      );
    }

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
