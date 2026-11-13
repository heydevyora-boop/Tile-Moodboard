/**
 * The client-facing half of the wishlist, and the studio's read of it.
 *
 * THE TOKEN IS THE ONLY KEY. Every client-facing handler takes it from
 * the URL and nothing else: there is no customer id, no wishlist id and
 * no email in any request a client makes, so there is no id for one
 * client to swap for another's. The studio's own endpoints sit behind
 * the normal login and the existing customers:read permission.
 */

import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import * as wishlist from '@services/clientWishlist.service';
import { syncWishlistToDrive, folderUrlFor } from '@services/clientWishlistDrive.service';
import { isStarterId } from '@services/libraryStarters';

// ============================================================
// Client-facing. No login; the token in the URL is the credential.
// ============================================================

export const register = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as { name: string; phone?: string };
  const { customer, wishlist: created } = await wishlist.registerClient(
    { name: body.name, phone: body.phone },
    req,
  );

  res.status(201).json({
    success: true,
    data: {
      // THE TOKEN IS SHOWN EXACTLY ONCE, here, to the browser that
      // registered. It is the client's whole identity, so it is never
      // returned by any other endpoint and never logged.
      token: created.token,
      clientId: customer.id,
      code: created.code,
      name: customer.name,
      phone: customer.phone,
      registeredAt: customer.createdAt,
      status: created.status,
      items: [],
    },
  });
});

export const getWishlist = catchAsync(async (req: Request, res: Response) => {
  const found = await wishlist.wishlistByToken(String(req.params.token));
  if (!found) {
    throw AppError.notFound(
      'That wishlist link is not one this studio issued, or it has been removed.',
    );
  }
  res.status(200).json({ success: true, data: wishlist.toPublicShape(found) });
});

export const addItem = catchAsync(async (req: Request, res: Response) => {
  const body = req.body as { imageId: string };
  const { added } = await wishlist.addItem(String(req.params.token), body.imageId, req);

  const refreshed = await wishlist.wishlistByToken(String(req.params.token));
  res.status(added ? 201 : 200).json({
    success: true,
    data: { added, ...wishlist.toPublicShape(refreshed!) },
  });
});

export const removeItem = catchAsync(async (req: Request, res: Response) => {
  // The id can arrive in the path or, for a client that would rather
  // not put a `starter:...` id in a URL, in the body. Same id either
  // way; the service resolves it the same way.
  const body = (req.body ?? {}) as { imageId?: string };
  const imageId = req.params.imageId || body.imageId || String(req.query.imageId ?? '');
  const { removed } = await wishlist.removeItem(String(req.params.token), imageId, req);

  const refreshed = await wishlist.wishlistByToken(String(req.params.token));
  res.status(200).json({
    success: true,
    data: { removed, ...wishlist.toPublicShape(refreshed!) },
  });
});

export const submit = catchAsync(async (req: Request, res: Response) => {
  const { wishlist: saved, alreadySubmitted } = await wishlist.submit(
    String(req.params.token),
    req,
  );
  res.status(200).json({
    success: true,
    data: { alreadySubmitted, ...wishlist.toPublicShape(saved) },
  });
});

export const themes = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({ success: true, data: await wishlist.themesForClient() });
});

export const images = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: await wishlist.imagesForClient(req.query.themeId) });
});

// ============================================================
// Studio-facing. Behind the normal login.
// ============================================================

/**
 * EVERY CLIENT WHO HAS REGISTERED, newest first.
 *
 * One query for the page and one for the total, with the picture
 * count coming back from the database as a count rather than as rows
 * -- so a hundred wishlists of fifty pictures each cost two queries,
 * not a hundred and one. Nothing here loads an image.
 */
export const list = catchAsync(async (req: Request, res: Response) => {
  const q = String(req.query.q ?? '').trim();
  const status = String(req.query.status ?? 'ALL').toUpperCase();
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  if (!['SUBMITTED', 'DRAFT', 'ALL'].includes(status)) {
    throw AppError.badRequest('status must be SUBMITTED, DRAFT or ALL.');
  }

  const where: Record<string, unknown> = {};
  if (status !== 'ALL') where.status = status;

  /* SEARCHED BY WHAT A PERSON ACTUALLY HAS IN FRONT OF THEM: the name
     a client gave, the DV- code they were shown, or the client id from
     a link. Case-insensitive on the name, because nobody types a
     showroom name the way it was entered. */
  if (q) {
    where.OR = [
      { customer: { name: { contains: q, mode: 'insensitive' } } },
      { customer: { phone: { contains: q } } },
      { code: { contains: q.toUpperCase() } },
      { customerId: q },
      { id: q },
    ];
  }

  // Registration date, inclusive of both ends. `to` is pushed to the
  // end of its day so that from=to=today means "today", which is what
  // a person picking one date in a date field means by it.
  const from = String(req.query.from ?? '').trim();
  const to = String(req.query.to ?? '').trim();
  if (from || to) {
    const range: Record<string, Date> = {};
    if (from) {
      const d = new Date(from);
      if (Number.isNaN(d.getTime())) throw AppError.badRequest('`from` is not a date.');
      range.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (Number.isNaN(d.getTime())) throw AppError.badRequest('`to` is not a date.');
      d.setHours(23, 59, 59, 999);
      range.lte = d;
    }
    where.createdAt = range;
  }

  const [rows, total] = await Promise.all([
    prisma.clientWishlist.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: {
        customer: { select: { id: true, name: true, phone: true, createdAt: true } },
        _count: { select: { items: true } },
      },
    }),
    prisma.clientWishlist.count({ where }),
  ]);

  res.status(200).json({
    success: true,
    data: {
      wishlists: rows.map(summarize),
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    },
  });
});

/** What the studio's list shows of one client. Never their token. */
function summarize(row: {
  id: string; code: string; status: string; submittedAt: Date | null; createdAt: Date;
  driveFolderId: string | null; driveSyncedAt: Date | null; driveError: string | null;
  customer: { id: string; name: string; phone: string | null; createdAt: Date };
  _count: { items: number };
}) {
  return {
    id: row.id,
    clientId: row.customer.id,
    code: row.code,
    name: row.customer.name,
    phone: row.customer.phone,
    registeredAt: row.customer.createdAt,
    status: row.status,
    submittedAt: row.submittedAt,
    createdAt: row.createdAt,
    itemCount: row._count.items,
    drive: {
      folderId: row.driveFolderId,
      folderUrl: folderUrlFor(row.driveFolderId || ''),
      syncedAt: row.driveSyncedAt,
      error: row.driveError,
    },
    // The token is a client's credential, not studio reading material,
    // so it is in no studio response.
  };
}

/** One client's wishlist in full -- the studio's view, not a token's. */
export const getOne = catchAsync(async (req: Request, res: Response) => {
  const row = await prisma.clientWishlist.findUnique({
    where: { id: String(req.params.id) },
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      items: {
        orderBy: { createdAt: 'asc' },
        // THE ORIGINAL LIBRARY REFERENCE, joined in one query rather
        // than fetched per picture. A wishlist of fifty rooms is one
        // round trip, not fifty-one.
        include: {
          reference: {
            select: { id: true, title: true, themeId: true, room: true, driveFileId: true, isActive: true },
          },
        },
      },
    },
  });
  if (!row) throw AppError.notFound('That wishlist no longer exists.');

  res.status(200).json({
    success: true,
    data: {
      id: row.id,
      clientId: row.customer.id,
      code: row.code,
      name: row.customer.name,
      phone: row.customer.phone,
      registeredAt: row.customer.createdAt,
      status: row.status,
      submittedAt: row.submittedAt,
      createdAt: row.createdAt,
      drive: {
        folderId: row.driveFolderId,
        folderUrl: folderUrlFor(row.driveFolderId || ''),
        syncedAt: row.driveSyncedAt,
        error: row.driveError,
      },
      items: row.items.map((item) => ({
        imageId: item.imageId,
        themeId: item.themeId,
        title: item.title,
        imageUrl: item.imageUrl,
        room: item.room,
        selectedAt: item.createdAt,
        /* WHAT THE CLIENT CHOSE, AND WHAT THE LIBRARY STILL HOLDS,
           side by side. They can differ: a picture deleted from the
           library leaves the choice intact with `reference` null,
           which is the whole point of storing the choice rather than
           a pointer. */
        driveFileId: item.driveFileId,
        driveCopyId: item.driveCopyId,
        reference: item.reference
          ? {
            id: item.reference.id,
            title: item.reference.title,
            themeId: item.reference.themeId,
            room: item.reference.room,
            driveFileId: item.reference.driveFileId,
            isActive: item.reference.isActive,
          }
          : null,
        isStarter: isStarterId(item.imageId),
      })),
    },
  });
});

/**
 * Build or finish this client's Drive folder, on demand.
 *
 * The same call submission makes, exposed to the owner so a sync that
 * failed -- Drive down, the connection expired, the folder unshared --
 * can be retried once the cause is fixed, without asking the client to
 * submit anything again. Doing it when nothing is outstanding is free
 * and changes nothing.
 */
export const driveSync = catchAsync(async (req: Request, res: Response) => {
  const row = await prisma.clientWishlist.findUnique({ where: { id: String(req.params.id) } });
  if (!row) throw AppError.notFound('That wishlist no longer exists.');

  const result = await syncWishlistToDrive(row.id);
  res.status(200).json({ success: true, data: { drive: result } });
});
