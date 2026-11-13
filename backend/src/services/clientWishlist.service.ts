/**
 * THE CLIENT'S OWN ROUND OF CHOOSING.
 *
 * A client walks in, gives a name, and starts hearting rooms. There is
 * no login: the token minted at registration is the whole of their
 * identity, exactly as mood_board_shares.token is for a shared board.
 * Every function here is reached BY THAT TOKEN and never by a client-
 * supplied customer or wishlist id, so one client cannot name another
 * client's record and be given it.
 *
 * NOTHING THE BROWSER SAYS ABOUT A PICTURE IS BELIEVED. The client
 * sends an image id and nothing else; the theme, the room, the title,
 * the Drive id and the URL are all read here, from the library. A
 * browser cannot invent a picture, move one between themes, or heart
 * something that is not in the library at all.
 *
 * THE PICTURES ARE REFERENCED, NEVER COPIED. An item points at the
 * library's own file. What is written down is the choice.
 */

import { Request } from 'express';
import crypto from 'crypto';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { generateOpaqueToken } from '@utils/crypto';
import { logActivity } from './activityLog.service';
import { describeTheme, THEMES } from './themes.service';
import { describeRoom } from './rooms.service';
import { isStarterId, starterById, asReference, STARTER_ROOMS } from './libraryStarters';
import { normalizeDriveImageUrl } from './referenceImages.service';
import * as library from './library.service';
import { syncWishlistToDrive, folderUrlFor } from './clientWishlistDrive.service';

/**
 * The short code a person can say across a showroom floor.
 *
 * No I, O, 0 or 1: it gets read aloud and written on paper, and those
 * four are the pairs that get misheard. Separate from the token
 * because it is meant to be readable, and therefore guessable -- it
 * identifies a wishlist to the studio, it does not open one.
 */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  const bytes = crypto.randomBytes(5);
  let code = '';
  for (let i = 0; i < 5; i += 1) code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `DV-${code}`;
}

export interface RegisterClientInput {
  /** Required. A registration without a name is not a registration. */
  name: string;
  /** Optional, as asked: a client who will not leave a number still gets one. */
  phone?: string;
}

/**
 * A new client, and the empty wishlist they start with.
 *
 * TWO CLIENTS WITH THE SAME NAME ARE TWO CLIENTS. Nothing here looks
 * for an existing customer to reuse: every registration is its own
 * row, its own code and its own token, so a second Priya does not
 * inherit the first Priya's choices.
 */
export async function registerClient(input: RegisterClientInput, req?: Request) {
  const name = String(input.name ?? '').trim();
  if (!name) throw AppError.badRequest('A name is needed to start a wishlist.');

  const phone = String(input.phone ?? '').trim();

  const customer = await prisma.customer.create({
    data: { name, phone: phone || null },
  });

  // The code is random and unique; a collision is rare and cheap to
  // retry, which beats holding a counter.
  let wishlist = null;
  for (let attempt = 0; attempt < 5 && !wishlist; attempt += 1) {
    try {
      wishlist = await prisma.clientWishlist.create({
        data: { customerId: customer.id, token: generateOpaqueToken(32), code: newCode() },
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'P2002' || attempt === 4) throw error;
    }
  }
  if (!wishlist) throw AppError.internal('A wishlist code could not be allocated.');

  await logActivity({
    userId: null,
    action: 'client_wishlist.registered',
    entityType: 'ClientWishlist',
    entityId: wishlist.id,
    metadata: { customerId: customer.id, code: wishlist.code },
    req,
  });

  return { customer, wishlist };
}

/** The wishlist this token opens, with its items and its client. */
export async function wishlistByToken(token: string) {
  const value = String(token ?? '').trim();
  if (!value) return null;

  return prisma.clientWishlist.findUnique({
    where: { token: value },
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });
}

/** The same, but a missing one is an error rather than a null. */
async function requireWishlist(token: string) {
  const wishlist = await wishlistByToken(token);
  if (!wishlist) {
    throw AppError.notFound(
      'That wishlist link is not one this studio issued, or it has been removed.',
    );
  }
  return wishlist;
}

export interface ResolvedImage {
  imageId: string;
  libraryReferenceId: string | null;
  driveFileId: string | null;
  themeId: string;
  room: string | null;
  title: string;
  imageUrl: string;
}

/**
 * WHAT A PICTURE ACTUALLY IS, read from the library rather than taken
 * from the request.
 *
 * Both kinds answer here: a starter, which is a file that ships with
 * the application, and an uploaded row. An id that is neither is
 * refused -- there is nothing to heart.
 */
export async function resolveImage(imageId: unknown): Promise<ResolvedImage> {
  const id = String(imageId ?? '').trim();
  if (!id) throw AppError.badRequest('No picture was named.');

  if (isStarterId(id)) {
    const starter = starterById(id);
    if (!starter) throw AppError.notFound('That reference room is not one of the studio’s.');
    const shaped = asReference(starter);
    return {
      imageId: id,
      libraryReferenceId: null,
      driveFileId: null,
      themeId: shaped.themeId,
      room: shaped.roomId ?? null,
      title: shaped.title,
      imageUrl: shaped.imageUrl,
    };
  }

  const row = await prisma.libraryReference.findFirst({
    where: { id, isActive: true },
    select: { id: true, themeId: true, room: true, title: true, imageUrl: true, driveFileId: true },
  });
  if (!row) throw AppError.notFound('That reference room is no longer in the De’vyora Library.');

  return {
    imageId: row.id,
    libraryReferenceId: row.id,
    driveFileId: row.driveFileId,
    themeId: row.themeId,
    room: row.room,
    title: row.title,
    // The browser-renderable form, for the same reason the gallery
    // uses it: the stored download url draws nothing in an <img>.
    imageUrl: normalizeDriveImageUrl(row.imageUrl) ?? row.imageUrl,
  };
}

/** A submitted round is the studio's copy; it stops changing. */
function refuseIfSubmitted(status: string) {
  if (status === 'SUBMITTED') {
    throw AppError.badRequest(
      'This wishlist has already been sent to the studio, so it can no longer be changed. '
      + 'Start a new one to choose again.',
    );
  }
}

/**
 * Heart one picture. Safe to repeat: the same picture twice is the
 * same wishlist, not an error and not a second row -- the unique
 * constraint says so and this agrees with it rather than fighting it.
 */
export async function addItem(token: string, imageId: unknown, req?: Request) {
  const wishlist = await requireWishlist(token);
  refuseIfSubmitted(wishlist.status);

  const image = await resolveImage(imageId);

  const existing = await prisma.wishlistItem.findUnique({
    where: { wishlistId_imageId: { wishlistId: wishlist.id, imageId: image.imageId } },
  });
  if (existing) return { item: existing, added: false };

  const item = await prisma.wishlistItem.create({
    data: {
      wishlistId: wishlist.id,
      imageId: image.imageId,
      libraryReferenceId: image.libraryReferenceId,
      driveFileId: image.driveFileId,
      themeId: image.themeId,
      room: image.room,
      title: image.title,
      imageUrl: image.imageUrl,
    },
  });

  await logActivity({
    userId: null,
    action: 'client_wishlist.item_added',
    entityType: 'ClientWishlist',
    entityId: wishlist.id,
    metadata: { imageId: image.imageId, themeId: image.themeId },
    req,
  });

  return { item, added: true };
}

/** Unheart one. Removing what is not there is already the wanted state. */
export async function removeItem(token: string, imageId: unknown, req?: Request) {
  const wishlist = await requireWishlist(token);
  refuseIfSubmitted(wishlist.status);

  const id = String(imageId ?? '').trim();
  const removed = await prisma.wishlistItem.deleteMany({
    where: { wishlistId: wishlist.id, imageId: id },
  });

  if (removed.count) {
    await logActivity({
      userId: null,
      action: 'client_wishlist.item_removed',
      entityType: 'ClientWishlist',
      entityId: wishlist.id,
      metadata: { imageId: id },
      req,
    });
  }

  return { removed: removed.count > 0 };
}

/**
 * Hand it to the studio. Submitting twice is submitting once: the
 * first submission's time is kept, because that is when the client
 * actually finished.
 */
export async function submit(token: string, req?: Request) {
  const wishlist = await requireWishlist(token);

  if (wishlist.status === 'SUBMITTED') {
    /* ALREADY SENT -- but perhaps Drive was not reachable when it was.
       The database has always been the record; the folder is a
       convenience on top of it, so a second tap is the natural moment
       to finish the part that did not happen. When it already
       happened, nothing is done at all: syncWishlistToDrive finds the
       same folder and skips every picture that carries a copy. */
    const drive = wishlist.driveSyncedAt
      ? {
        ok: true,
        folderId: wishlist.driveFolderId || '',
        folderUrl: folderUrlFor(wishlist.driveFolderId || ''),
        copied: 0,
        alreadyThere: wishlist.items.length,
        reason: '',
      }
      : await syncWishlistToDrive(wishlist.id);

    return { wishlist, alreadySubmitted: true, drive };
  }

  if (!wishlist.items.length) {
    throw AppError.badRequest('Nothing has been chosen yet, so there is nothing to send.');
  }

  const updated = await prisma.clientWishlist.update({
    where: { id: wishlist.id },
    data: { status: 'SUBMITTED', submittedAt: new Date() },
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });

  await logActivity({
    userId: null,
    action: 'client_wishlist.submitted',
    entityType: 'ClientWishlist',
    entityId: wishlist.id,
    metadata: { code: wishlist.code, items: updated.items.length },
    req,
  });

  /* THE SUBMISSION HAS ALREADY SUCCEEDED by this line, and nothing
     below may undo that. syncWishlistToDrive never throws: at worst it
     returns a reason, which is written to driveError for the owner to
     see and retry. A studio whose Drive is down still gets every
     wishlist its clients send. */
  const drive = await syncWishlistToDrive(wishlist.id);

  const after = await prisma.clientWishlist.findUnique({
    where: { id: wishlist.id },
    include: {
      customer: { select: { id: true, name: true, phone: true, createdAt: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });

  return { wishlist: after ?? updated, alreadySubmitted: false, drive };
}

/**
 * THE THEMES A CLIENT CHOOSES FROM, plus Others.
 *
 * The nine come from shared/themes.json exactly as the Library's own
 * page gets them -- there is no second list to keep in step. Others is
 * not a tenth theme: it is every picture in all of them, which is why
 * it carries the total and has no palette of its own.
 */
export const OTHERS_THEME_ID = 'others';

export async function themesForClient() {
  let counts: library.LibraryCounts = { byTheme: {}, byRoom: {} };
  let storageError = '';
  try {
    counts = await library.countByTheme();
  } catch (error) {
    storageError = library.describeStorageFailure(error);
  }

  const starterCountsByTheme: Record<string, number> = {};
  for (const room of STARTER_ROOMS) {
    starterCountsByTheme[room.themeId] = (starterCountsByTheme[room.themeId] || 0) + 1;
  }

  // Object.values, and de-duplicated, for the same reason the Library's
  // own /themes endpoint does it: themes.json is keyed by id and also
  // carries slug aliases, so a plain listing would show nine themes and
  // a few repeats.
  const themes = Object.values(THEMES)
    .map((theme) => ({
      id: theme.id,
      label: theme.label,
      slug: theme.slug,
      palette: theme.palette,
      count: (counts.byTheme[theme.id] || 0) + (starterCountsByTheme[theme.id] || 0),
    }))
    .filter((theme, index, all) => all.findIndex((t) => t.id === theme.id) === index);

  const total = themes.reduce((sum, theme) => sum + theme.count, 0);

  return {
    themes: [
      ...themes,
      {
        id: OTHERS_THEME_ID,
        label: 'Others',
        slug: OTHERS_THEME_ID,
        palette: 'Every room in the library, whatever its theme',
        count: total,
      },
    ],
    storage: { ok: !storageError, reason: storageError },
  };
}

/**
 * The pictures of one theme, or -- for Others -- of all of them.
 *
 * Starters first, then the studio's own, the same order the Library
 * shows. Others includes every starter too, which the Library's own
 * all-themes listing does not do, because a client choosing from
 * "everything" should see everything.
 */
export async function imagesForClient(themeId?: unknown) {
  const wanted = String(themeId ?? '').trim();
  const isOthers = !wanted || wanted === OTHERS_THEME_ID;

  const theme = isOthers ? null : describeTheme(wanted);
  if (!isOthers && !theme) {
    throw AppError.badRequest(`"${wanted}" is not one of the studio’s themes.`);
  }

  const starters = (isOthers
    ? STARTER_ROOMS
    : STARTER_ROOMS.filter((room) => room.themeId === theme!.id)
  ).map(asReference);

  let uploaded: unknown[] = [];
  let storageError = '';
  try {
    uploaded = await library.listReferences(isOthers ? undefined : theme!.id);
  } catch (error) {
    storageError = library.describeStorageFailure(error);
  }

  const images = [...starters, ...uploaded].map((entry) => {
    const row = entry as {
      id: string; themeId: string; title: string; imageUrl: string;
      room?: string | null; roomId?: string | null; isStarter?: boolean;
    };
    const roomId = row.roomId ?? row.room ?? null;
    const room = roomId ? describeRoom(roomId) : null;
    return {
      imageId: row.id,
      themeId: row.themeId,
      themeLabel: describeTheme(row.themeId)?.label || row.themeId,
      title: row.title,
      // Browser-renderable: a stored Drive download url draws nothing.
      imageUrl: normalizeDriveImageUrl(row.imageUrl) ?? row.imageUrl,
      room: room ? room.label : null,
      roomId: room ? room.id : null,
      isStarter: !!row.isStarter,
    };
  });

  return { images, storage: { ok: !storageError, reason: storageError } };
}

/** What a client is allowed to see of their own wishlist. */
export function toPublicShape(wishlist: NonNullable<Awaited<ReturnType<typeof wishlistByToken>>>) {
  return {
    clientId: wishlist.customer.id,
    code: wishlist.code,
    name: wishlist.customer.name,
    phone: wishlist.customer.phone,
    registeredAt: wishlist.customer.createdAt,
    status: wishlist.status,
    submittedAt: wishlist.submittedAt,
    driveFolderId: wishlist.driveFolderId,
    driveFolderUrl: folderUrlFor(wishlist.driveFolderId || ''),
    items: wishlist.items.map((item) => ({
      imageId: item.imageId,
      themeId: item.themeId,
      title: item.title,
      imageUrl: item.imageUrl,
      room: item.room,
      selectedAt: item.createdAt,
    })),
  };
}
