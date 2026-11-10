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
 * Submitted wishlists, newest first -- the point of submitting one.
 *
 * Drafts are included only when asked for: a wishlist a client is
 * still working through is not yet a message to the studio.
 */
export const list = catchAsync(async (req: Request, res: Response) => {
  const status = String(req.query.status ?? 'SUBMITTED').toUpperCase();
  if (!['SUBMITTED', 'DRAFT', 'ALL'].includes(status)) {
    throw AppError.badRequest('status must be SUBMITTED, DRAFT or ALL.');
  }

  const rows = await prisma.clientWishlist.findMany({
    where: status === 'ALL' ? {} : { status: status as 'DRAFT' | 'SUBMITTED' },
    orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      _count: { select: { items: true } },
    },
  });

  res.status(200).json({
    success: true,
    data: {
      wishlists: rows.map((row) => ({
        id: row.id,
        code: row.code,
        status: row.status,
        submittedAt: row.submittedAt,
        createdAt: row.createdAt,
        itemCount: row._count.items,
        client: row.customer,
        // The token is a client's credential, not studio reading
        // material, so it is not in this response.
      })),
    },
  });
});

/** One wishlist in full, by its own id -- the studio's view, not a token's. */
export const getOne = catchAsync(async (req: Request, res: Response) => {
  const row = await prisma.clientWishlist.findUnique({
    where: { id: String(req.params.id) },
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!row) throw AppError.notFound('That wishlist no longer exists.');

  const shape = wishlist.toPublicShape(row);
  res.status(200).json({ success: true, data: { id: row.id, ...shape } });
});
