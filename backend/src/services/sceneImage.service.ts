/**
 * THE CHOSEN REFERENCE ROOM, AS BYTES RATHER THAN AS AN ADDRESS.
 *
 * The Python generator needs the picture a board is built on. Until
 * now it was handed a URL and told to fetch it itself, over the public
 * internet, from this deployment's own front door. Every step of that
 * journey is somebody else's to break, and each one has:
 *
 *   - Drive's uc?export=download answers a server with an HTML page
 *     rather than the file;
 *   - main_step6_complete.py rewrites any drive.google.com address back
 *     to that same form before fetching, so no Drive URL survives;
 *   - serving the bytes from this deployment fixed both -- and then a
 *     Vercel preview's Deployment Protection, which sits at the edge in
 *     FRONT of every function, answered the fetch with its sign-in page
 *     carrying a 200, which Pillow reports as "the remote scene image
 *     did not contain a valid image file".
 *
 * Each was a real fault and each was really fixed. But they are all the
 * same shape: a second machine fetching a picture THIS one already has.
 *
 * So it stops fetching. This reads the bytes here -- from Drive with
 * this deployment's own credential, or from the starter file in the
 * bundle -- and hands them over inline, as a data: URL. Python's
 * urlopen reads one natively, _build_remote_download_url leaves it
 * alone (it rewrites Drive hosts only), and Pillow validates it exactly
 * as it would a downloaded file. No request leaves the generator, so
 * there is no edge to be stopped at, no sharing to get wrong and no URL
 * to be rewritten.
 *
 * NOTHING IN THE EXTRACTION OR GENERATION PIPELINE CHANGES. This only
 * decides what goes in the `scene_image_url` field that pipeline
 * already reads.
 */

import fs from 'fs';
import path from 'path';

import { googleDriveClient } from '@services/googleDrive.service';
import { isRealImageBuffer } from '@utils/fileSignature';

/**
 * Where the starter rooms sit on disk.
 *
 * Both spellings, for the reason app.ts mounts both: the repository
 * layout differs between running from src/ and from a bundle.
 */
const STARTER_DIRS = [
  path.resolve(__dirname, '..', '..', '..', 'frontend', 'img', 'library'),
  path.resolve(process.cwd(), '..', 'frontend', 'img', 'library'),
];

/**
 * How much encoded picture may ride along in the request body.
 *
 * A serverless request body is capped (4.5 MB on Vercel), and the
 * board's materials travel in the same body. 3 MB of base64 is about
 * 2.2 MB of picture and leaves room for the rest; anything that will
 * not fit is reduced below, and only if THAT fails does the caller go
 * back to sending an address.
 */
const INLINE_BUDGET = 3_000_000;

/** Tried in order until one fits: longest side in px, JPEG quality. */
const REDUCTIONS: Array<{ maxSide: number; quality: number }> = [
  { maxSide: 1600, quality: 82 },
  { maxSide: 1200, quality: 75 },
  { maxSide: 900, quality: 70 },
];

export type SceneImageSource = {
  /** An uploaded reference: the Drive file this row stores. */
  driveFileId?: string | null;
  /** A starter room: its file under frontend/img/library. */
  starterFile?: string | null;
};

/** The starter's bytes, or null when the file is not where it should be. */
function readStarterBytes(file: string): Buffer | null {
  // Only the basename: `file` comes from this application's own table
  // of starters, but reading it as a path at all is what would let a
  // future caller walk out of that directory.
  const name = path.basename(file);

  for (const dir of STARTER_DIRS) {
    const candidate = path.join(dir, name);
    try {
      if (fs.existsSync(candidate)) return fs.readFileSync(candidate);
    } catch {
      // Unreadable here; try the other layout.
    }
  }
  return null;
}

/**
 * The picture itself, or null if this deployment cannot read it.
 *
 * Null is not a failure to report: the caller falls back to sending an
 * address, which is what it did before this existed.
 */
export async function readSceneImageBytes(
  source: SceneImageSource,
): Promise<Buffer | null> {
  try {
    const bytes = source.starterFile
      ? readStarterBytes(source.starterFile)
      : source.driveFileId
        ? (await googleDriveClient.downloadFile(source.driveFileId)).bytes
        : null;

    // The same check /static/library-reference makes: a sign-in page
    // served with an image mime type must not be passed on to a
    // decoder that cannot say what went wrong.
    return bytes && bytes.length > 0 && isRealImageBuffer(bytes) ? bytes : null;
  } catch {
    // Drive refused, the file is gone, the credential has expired --
    // all of which the address path reports in its own words.
    return null;
  }
}

/** The data: URL for these bytes, reduced if it has to be, or null. */
export async function toInlineSceneImage(bytes: Buffer): Promise<string | null> {
  const asIs = dataUrl(bytes, sniffMime(bytes));
  // THE PICTURE EXACTLY AS THE STUDIO SEES IT, whenever it fits. The
  // reductions below are a concession to a request body, not an
  // improvement, so they are only reached when there is no choice.
  if (asIs.length <= INLINE_BUDGET) return asIs;

  for (const step of REDUCTIONS) {
    const smaller = await reduce(bytes, step.maxSide, step.quality);
    if (!smaller) break;
    const url = dataUrl(smaller, 'image/jpeg');
    if (url.length <= INLINE_BUDGET) return url;
  }

  return null;
}

/** Both halves at once: the bytes, inlined, or null to send an address. */
export async function inlineSceneImageFor(
  source: SceneImageSource,
): Promise<string | null> {
  const bytes = await readSceneImageBytes(source);
  return bytes ? toInlineSceneImage(bytes) : null;
}

function dataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString('base64')}`;
}

/** What the bytes say they are. Pillow reads the bytes, not this. */
function sniffMime(bytes: Buffer): string {
  const head = bytes.subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (head.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png';
  if (head.subarray(0, 4).toString('ascii') === 'RIFF'
    && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  return 'application/octet-stream';
}

/**
 * The same picture, smaller, for transport only.
 *
 * Not part of the image pipeline and not written anywhere: this exists
 * so a large photograph can ride in a request body rather than being
 * sent as an address nobody can fetch. The aspect ratio is kept, and a
 * picture already smaller than the target is left at its own size.
 */
async function reduce(
  bytes: Buffer,
  maxSide: number,
  quality: number,
): Promise<Buffer | null> {
  try {
    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(bytes);

    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    const width = Math.max(1, Math.round(image.width * scale));
    const height = Math.max(1, Math.round(image.height * scale));

    const canvas = createCanvas(width, height);
    canvas.getContext('2d').drawImage(image, 0, 0, width, height);
    return canvas.toBuffer('image/jpeg', quality);
  } catch {
    // No decoder for this format, or the picture is too large to
    // decode. The caller sends an address instead.
    return null;
  }
}
