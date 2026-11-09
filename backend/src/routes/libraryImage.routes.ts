/**
 * THE LIBRARY'S PICTURES, SERVED FROM THIS DEPLOYMENT.
 *
 *   GET /static/library-reference/<driveFileId>
 *
 * WHY THIS EXISTS, rather than handing out a Drive link.
 *
 * The Python visualization service fetches the chosen reference room
 * over the public internet, and two things stand in the way of any
 * Drive address doing that job:
 *
 *   1. uc?export=download answers a server with an HTML download page
 *      rather than the file, so whatever tries to decode it reports
 *      "cannot identify image file".
 *   2. main_step6_complete.py REWRITES any drive.google.com or
 *      drive.usercontent.google.com URL back to that same download
 *      form before fetching it (_build_remote_download_url). So no
 *      choice of Drive URL made here survives the trip -- the
 *      thumbnail address this server sent was never the one fetched.
 *
 * A URL on this deployment's own host is left alone by that rewrite,
 * and the bytes behind it are read with this deployment's own Drive
 * credential. Whether the file was ever shared publicly stops
 * mattering, which removes the whole class of failure rather than the
 * latest instance of it.
 *
 * PUBLIC, because the service that fetches it is another machine with
 * no session. It is not an open proxy: the id must belong to a
 * library reference this database knows, so nothing else in the
 * studio's Drive can be read through it.
 */

import { Router, Request, Response } from 'express';
import { prisma } from '@db/connection';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import { googleDriveClient } from '@services/googleDrive.service';
import { isRealImageBuffer } from '@utils/fileSignature';

const router = Router();

router.get(
  '/:fileId',
  catchAsync(async (req: Request, res: Response) => {
    const fileId = String(req.params.fileId || '').replace(/\.[A-Za-z0-9]+$/, '').trim();
    if (!fileId) throw AppError.badRequest('No file was asked for.');

    // THE GUARD THAT KEEPS THIS FROM BEING AN OPEN PROXY. Only a file
    // this library actually holds can be read through here.
    const reference = await prisma.libraryReference.findFirst({
      where: { driveFileId: fileId, isActive: true },
      select: { id: true },
    });
    if (!reference) throw AppError.notFound('That picture is not in the De’vyora Library.');

    const file = await googleDriveClient.downloadFile(fileId);

    // Drive's own word for what it is, checked against the bytes: a
    // sign-in page served with an image mime type would otherwise be
    // passed on to a decoder that cannot say what went wrong.
    if (!isRealImageBuffer(file.bytes)) {
      throw AppError.badRequest(
        `The library picture ${fileId} did not come back from Drive as an image.`,
      );
    }

    res.setHeader('Content-Type', file.mimeType.startsWith('image/') ? file.mimeType : 'image/jpeg');
    res.setHeader('Content-Length', String(file.bytes.length));
    // The picture never changes, and the generator fetches it once per
    // generation.
    res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
    res.status(200).end(file.bytes);
  }),
);

export default router;
