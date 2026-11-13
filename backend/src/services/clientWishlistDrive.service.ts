/**
 * THE CLIENT'S OWN FOLDER ON THE STUDIO'S DRIVE.
 *
 *   <the studio's Drive folder>/
 *     Client Wishlists/
 *       Aarti Mehta - DV-RVJNK/
 *         Wishlist Images/
 *           Heritage Green Cloakroom.png
 *
 * Built after a wishlist is submitted, from the pictures that were
 * actually chosen.
 *
 * FOUR RULES, AND THE WHOLE FILE IS THEM:
 *
 * 1. THE ORIGINALS ARE ONLY EVER READ. A library picture is copied
 *    (files.copy) or, for a starter, uploaded from the file that ships
 *    with the application. Nothing here moves, renames, re-parents or
 *    deletes anything that already existed -- this module calls no
 *    delete and no move, and there is a test that greps for it.
 *
 * 2. DOING IT TWICE CHANGES NOTHING. Folders are found by name before
 *    they are created, and a picture that already carries a
 *    driveCopyId is skipped. A client who taps Submit again, or an
 *    owner who retries a failed sync, gets the same one folder and the
 *    same one copy of each picture.
 *
 * 3. DRIVE CANNOT COST THE STUDIO THE WISHLIST. The database is the
 *    record; Drive is a convenience on top of it. Every failure here
 *    is caught, written to driveError, and reported -- never thrown
 *    into the client's submission, which has already succeeded.
 *
 * 4. NOTHING ABOUT THE EXISTING CONFIGURATION CHANGES. The same OAuth
 *    client, the same scopes, the same service-account fallback and
 *    the same configured library folder as the De'vyora Library's own
 *    uploads. Client folders are created INSIDE that folder, because
 *    with `drive.file` it is the one place this credential is
 *    permitted to create anything.
 */

import fs from 'fs';
import path from 'path';
import { prisma } from '@db/connection';
import { googleDriveClient } from './googleDrive.service';
import * as library from './library.service';
import { isStarterId, starterById } from './libraryStarters';

/** The one folder every client's folder is made inside. */
export const CLIENT_ROOT_FOLDER = 'Client Wishlists';
/** ...and the one inside each client's, holding the pictures. */
export const IMAGES_FOLDER = 'Wishlist Images';

export interface DriveSyncResult {
  /** True when the folder exists and every chosen picture is in it. */
  ok: boolean;
  /** The client's own folder, when there is one. */
  folderId: string;
  /** A link an owner can open, when there is a folder. */
  folderUrl: string;
  /** Copied on THIS run. */
  copied: number;
  /** Already there from a previous run, and so left alone. */
  alreadyThere: number;
  /** Written to driveError, and shown to the owner, when not ok. */
  reason: string;
}

function none(reason: string): DriveSyncResult {
  return { ok: false, folderId: '', folderUrl: '', copied: 0, alreadyThere: 0, reason };
}

export function folderUrlFor(folderId: string): string {
  return folderId ? `https://drive.google.com/drive/folders/${folderId}` : '';
}

/**
 * A folder name a person can read, and Drive will accept.
 *
 * Drive itself allows almost anything, but a slash reads as a path in
 * every tool that syncs the folder to a disk, so it goes. The code is
 * on the end because two clients are quite often called the same
 * thing, and the code is the thing the studio says out loud.
 */
export function folderNameFor(clientName: string, code: string): string {
  const clean = String(clientName || '').replace(/[\\/\r\n\t]+/g, ' ').trim().slice(0, 80)
    || 'Unnamed client';
  return `${clean} - ${code}`;
}

/** A file name that says which room it is. */
function fileNameFor(title: string, imageId: string, fallbackExt: string): string {
  const clean = String(title || '').replace(/[\\/\r\n\t]+/g, ' ').trim().slice(0, 90)
    || imageId;
  return /\.[a-z0-9]{3,4}$/i.test(clean) ? clean : `${clean}${fallbackExt}`;
}

/** Where a starter's bytes actually live, trying both repository layouts. */
function starterFilePath(file: string): string | null {
  const candidates = [
    path.resolve(__dirname, '..', '..', '..', 'frontend', 'img', 'library', file),
    path.resolve(process.cwd(), '..', 'frontend', 'img', 'library', file),
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

/**
 * Bring one wishlist's Drive folder up to date.
 *
 * Safe to call as often as you like: it is the whole point. It never
 * throws -- the worst it does is come back with ok false and a reason
 * worth showing someone.
 */
export async function syncWishlistToDrive(wishlistId: string): Promise<DriveSyncResult> {
  const wishlist = await prisma.clientWishlist.findUnique({
    where: { id: wishlistId },
    include: {
      customer: { select: { name: true } },
      items: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!wishlist) return none('That wishlist no longer exists.');

  if (!googleDriveClient.isConfigured()) {
    return record(wishlistId, none(
      'Google Drive is not connected, so no client folder was created. The wishlist itself '
      + 'is saved in full. Connect the studio’s Google account and sync again.',
    ));
  }

  // The same folder the library uploads into, and the same explanation
  // when it cannot be opened -- there is one Drive setting here, not
  // two that can disagree.
  const parent = await library.describeLibraryFolder();
  if (!parent.ok || !parent.folderId) {
    return record(wishlistId, none(
      parent.reason
      || 'The studio’s Google Drive folder could not be opened, so no client folder was created.',
    ));
  }

  let folderId = wishlist.driveFolderId || '';
  let copied = 0;
  let alreadyThere = 0;

  try {
    // Found by name before being created, at every level -- which is
    // what makes a second submission reuse the first one's folders.
    const root = await googleDriveClient.getOrCreateFolder(CLIENT_ROOT_FOLDER, parent.folderId);
    const clientFolder = await googleDriveClient.getOrCreateFolder(
      folderNameFor(wishlist.customer.name, wishlist.code),
      root.id,
    );
    folderId = clientFolder.id;

    if (wishlist.driveFolderId !== folderId) {
      await prisma.clientWishlist.update({
        where: { id: wishlistId },
        data: { driveFolderId: folderId },
      });
    }

    const images = await googleDriveClient.getOrCreateFolder(IMAGES_FOLDER, clientFolder.id);

    for (const item of wishlist.items) {
      // Already copied on an earlier run. This is the line that makes
      // a repeated submission free.
      if (item.driveCopyId) { alreadyThere += 1; continue; }

      let copyId = '';

      if (item.driveFileId) {
        // A studio upload: Drive copies it to itself, and the original
        // is untouched.
        const copy = await googleDriveClient.copyFile(
          item.driveFileId,
          fileNameFor(item.title, item.imageId, '.jpg'),
          images.id,
        );
        copyId = copy.id;
      } else if (isStarterId(item.imageId)) {
        // A starter is a file that ships with the application and has
        // no Drive original to copy, so its bytes are uploaded.
        const starter = starterById(item.imageId);
        const file = starter ? starterFilePath(starter.file) : null;
        if (!file) continue;
        const uploaded = await googleDriveClient.uploadFile({
          name: fileNameFor(item.title, item.imageId, '.png'),
          mimeType: 'image/png',
          content: fs.readFileSync(file),
          parentFolderId: images.id,
        });
        copyId = uploaded.id;
      } else {
        continue;
      }

      await prisma.wishlistItem.update({ where: { id: item.id }, data: { driveCopyId: copyId } });
      copied += 1;
    }
  } catch (error) {
    // Partial work is kept: every copy already recorded stays
    // recorded, so a retry resumes rather than starts again.
    return record(wishlistId, {
      ok: false,
      folderId,
      folderUrl: folderUrlFor(folderId),
      copied,
      alreadyThere,
      reason: describeDriveFailure(error),
    });
  }

  const outstanding = wishlist.items.length - (copied + alreadyThere);

  return record(wishlistId, {
    ok: outstanding === 0,
    folderId,
    folderUrl: folderUrlFor(folderId),
    copied,
    alreadyThere,
    reason: outstanding === 0
      ? ''
      : `${outstanding} of ${wishlist.items.length} pictures could not be copied, because the `
        + 'library no longer holds a file for them. The wishlist itself is complete.',
  });
}

/** What the owner is shown, and what a retry starts from. */
async function record(wishlistId: string, result: DriveSyncResult): Promise<DriveSyncResult> {
  await prisma.clientWishlist.update({
    where: { id: wishlistId },
    data: {
      driveSyncedAt: result.ok ? new Date() : null,
      driveError: result.ok ? null : result.reason.slice(0, 500),
    },
  }).catch(() => { /* the result still stands even if this note cannot be kept */ });
  return result;
}

/**
 * Google's errors, in words that name the remedy.
 *
 * The same shape as library.describeStorageFailure: a studio reading
 * "insufficientPermissions" has nothing to act on.
 */
export function describeDriveFailure(error: unknown): string {
  const message = (error as { message?: string } | null)?.message || String(error);

  if (/insufficient|permission|forbidden|403/i.test(message)) {
    return 'Google Drive refused the copy for want of permission. The connected Google account '
      + 'needs edit access to the studio’s Drive folder. The wishlist itself is saved in full.';
  }
  if (/not found|404/i.test(message)) {
    return 'Google Drive could not find one of the files to copy — it may have been removed from '
      + 'the studio’s Drive. The wishlist itself is saved in full.';
  }
  if (/quota|storage/i.test(message)) {
    return 'Google Drive refused the copy for want of storage quota. The wishlist itself is '
      + 'saved in full.';
  }
  if (/invalid_grant|unauthorized|401|token/i.test(message)) {
    return 'The studio’s Google connection has expired, so no pictures were copied. '
      + 'Reconnect Google Drive and sync again. The wishlist itself is saved in full.';
  }
  return `Google Drive did not complete the copy: ${message}. The wishlist itself is saved in full.`;
}
