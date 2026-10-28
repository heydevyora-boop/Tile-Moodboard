import { PDFDocument, PDFImage, PDFPage, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import { toPoints } from '@utils/printDimensions';
import { colorForTile } from '@utils/tileColorSwatches';
import { AppError } from '@utils/AppError';

/**
 * The client-facing mood board as a PDF, at the exact physical size the
 * showroom picked.
 *
 * Deliberately separate from printBoardRenderer.service.ts, which serves
 * the PrintBoard entity: that one draws labelled COLOUR SWATCHES at a
 * chosen DPI and layout enum, because reliably fetching arbitrary remote
 * tile images was out of its scope. This one is the opposite case -- the
 * whole point is the real photography, the generated bathroom scene above
 * the products it was built from -- so it fetches and embeds the actual
 * images, and falls back to that same swatch only for a product whose
 * image cannot be read. Keeping them apart leaves the print-shop path
 * untouched.
 */

export interface MoodBoardPdfTile {
  role: string;
  name: string;
  brandName?: string | null;
  size?: string | null;
  colorTone?: string | null;
  imageUrl?: string | null;
}

export interface MoodBoardPdfInput {
  boardName: string;
  brief?: string | null;
  grout?: string | null;
  /** Physical board size in feet. 1 ft = 72 pt, so these are exact. */
  widthFt: number;
  heightFt: number;
  sceneImageUrl?: string | null;
  /**
   * The generated scene's own bytes, as a data: URL.
   *
   * Needed because the generator does not hand back an address this
   * server can fetch. On Vercel, Node and Python run as separate
   * functions with no shared disk, so Python embeds the image it just
   * wrote as a data: URL and that is what reaches the browser (see
   * python-ai.service.ts). A data: URL means something only inside the
   * tab holding it -- fetching it from here is not possible -- so the
   * browser posts the bytes instead, and they are embedded directly.
   *
   * sceneImageUrl still covers the case where the scene DOES have a
   * fetchable address, which is what Drive gives when it is connected.
   */
  sceneImage?: string | null;
  tiles: MoodBoardPdfTile[];
}

// A board is one page of artwork, not a document: five images at the
// sizes a catalogue thumbnail comes in is the realistic load. The cap is
// here so one malformed request cannot hold a serverless invocation open
// fetching indefinitely.
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;

const INK = rgb(0.11, 0.1, 0.08);
const MUTED = rgb(0.47, 0.44, 0.36);
const HAIRLINE = rgb(0.75, 0.71, 0.62);
const GOLD = rgb(0.68, 0.51, 0.31);

/** PNG and JPEG are what pdf-lib embeds natively; anything else is re-encoded. */
function imageKind(bytes: Uint8Array): 'png' | 'jpg' | 'other' {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png';
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  return 'other';
}

/**
 * WebP and the rest go through the canvas that is already a dependency
 * (printBoardPngRenderer uses it) rather than pulling in an image
 * library: decode once, hand pdf-lib a PNG it can embed.
 */
async function toEmbeddablePng(bytes: Uint8Array): Promise<Uint8Array> {
  const { createCanvas, loadImage } = await import('@napi-rs/canvas');
  const image = await loadImage(Buffer.from(bytes));
  const canvas = createCanvas(image.width, image.height);
  canvas.getContext('2d').drawImage(image, 0, 0);
  return new Uint8Array(canvas.toBuffer('image/png'));
}

/** The bytes behind a data: URL, or null when it is not one this can read. */
function inlineBytes(source: string): Uint8Array | null {
  const comma = source.indexOf(',');
  if (comma < 0) return null;
  const header = source.slice(0, comma);
  if (!/^data:image\/[a-z0-9.+-]+;base64$/i.test(header)) return null;

  const bytes = new Uint8Array(Buffer.from(source.slice(comma + 1), 'base64'));
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  return bytes;
}

/** The bytes behind an http(s) URL, or null when it cannot be read. */
async function fetchedBytes(url: string): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;
    return new Uint8Array(buffer);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads one image -- either an http(s) address to fetch, or a data: URL
 * whose bytes are already here. Returns null rather than throwing: a
 * single unreachable thumbnail must not cost the client their whole
 * board, and the caller falls back to a labelled swatch for it.
 */
async function embedImage(doc: PDFDocument, source: string | null | undefined): Promise<PDFImage | null> {
  if (!source) return null;

  try {
    let bytes: Uint8Array | null;
    if (/^data:/i.test(source)) bytes = inlineBytes(source);
    else if (/^https?:\/\//i.test(source)) bytes = await fetchedBytes(source);
    else return null;
    if (!bytes) return null;

    const kind = imageKind(bytes);
    if (kind === 'jpg') return await doc.embedJpg(bytes);
    if (kind === 'png') return await doc.embedPng(bytes);
    return await doc.embedPng(await toEmbeddablePng(bytes));
  } catch {
    return null;
  }
}

/** Fits an image inside a box without ever stretching it. */
function containedBox(image: PDFImage, x: number, y: number, boxW: number, boxH: number) {
  const scale = Math.min(boxW / image.width, boxH / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: x + (boxW - width) / 2, y: y + (boxH - height) / 2, width, height };
}

function drawClipped(page: PDFPage, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, color = INK) {
  let shown = text;
  while (shown.length > 1 && font.widthOfTextAtSize(shown, size) > maxWidth) {
    shown = shown.slice(0, -1);
  }
  if (shown !== text && shown.length > 1) shown = `${shown.slice(0, -1)}…`;
  page.drawText(shown, { x, y, size, font, color });
}

/**
 * How many products sit side by side. A 10x4 board is a long strip and
 * wants them in one row; a 2x4 board is a column. Derived from the
 * board's own aspect ratio so the same rule covers all nine sizes
 * without a table of special cases.
 */
export function tileColumns(widthFt: number, heightFt: number, tileCount: number): number {
  if (tileCount <= 1) return 1;
  const ratio = widthFt / heightFt;
  return Math.max(1, Math.min(tileCount, Math.round(ratio * 2)));
}

export async function renderMoodBoardPdf(input: MoodBoardPdfInput): Promise<Uint8Array> {
  if (!(input.widthFt > 0) || !(input.heightFt > 0)) {
    throw AppError.badRequest('A mood board needs a positive width and height in feet');
  }

  // 1 ft = 12 in = 864 pt. toPoints is the same conversion the print
  // board path uses, so "4 ft" means the same thing in both exports.
  const widthPt = toPoints(input.widthFt, 'FT');
  const heightPt = toPoints(input.heightFt, 'FT');

  const doc = await PDFDocument.create();
  doc.setTitle(`${input.boardName} — De’vyora`);
  doc.setProducer('De’vyora');

  const page = doc.addPage([widthPt, heightPt]);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Everything scales off the page's shorter side, so a 2x2 board is a
  // small version of the same design rather than a 10x4 one with
  // oversized type.
  const unit = Math.min(widthPt, heightPt);
  const margin = unit * 0.05;
  const contentW = widthPt - margin * 2;

  page.drawRectangle({ x: 0, y: 0, width: widthPt, height: heightPt, color: rgb(0.984, 0.965, 0.925) });

  // ── header ────────────────────────────────────────────────────────
  const titleSize = Math.max(9, unit * 0.038);
  const metaSize = Math.max(6, unit * 0.019);
  let cursorY = heightPt - margin - titleSize;

  page.drawText('DE’VYORA', { x: margin, y: cursorY, size: metaSize, font: bold, color: GOLD });
  cursorY -= titleSize * 1.15;
  drawClipped(page, input.boardName, margin, cursorY, contentW, bold, titleSize);
  cursorY -= metaSize * 1.9;

  const sizeLabel = `${input.widthFt} ft × ${input.heightFt} ft`;
  drawClipped(page, sizeLabel, margin, cursorY, contentW, regular, metaSize, MUTED);
  cursorY -= metaSize * 1.2;

  // ── footer reserved first, so the artwork never runs into it ──────
  const footerLines = [
    input.grout ? `Grout: ${input.grout}` : null,
    input.brief ? String(input.brief) : null,
  ].filter((line): line is string => Boolean(line));
  const footerH = footerLines.length * metaSize * 1.5 + metaSize;
  const artworkTop = cursorY - metaSize * 0.6;
  const artworkBottom = margin + footerH;
  const artworkH = artworkTop - artworkBottom;

  // ── the generated bathroom scene, on top ──────────────────────────
  const scene = await embedImage(doc, input.sceneImage || input.sceneImageUrl);
  const tiles = input.tiles.slice(0, 8);
  const sceneShare = tiles.length > 0 ? 0.56 : 0.98;
  const sceneH = artworkH * sceneShare;

  if (scene) {
    const box = containedBox(scene, margin, artworkTop - sceneH, contentW, sceneH);
    page.drawImage(scene, box);
  } else {
    page.drawRectangle({
      x: margin, y: artworkTop - sceneH, width: contentW, height: sceneH,
      color: rgb(0.945, 0.925, 0.878), borderColor: HAIRLINE, borderWidth: 0.75,
    });
    drawClipped(page, 'No bathroom scene has been rendered for this combination', margin + metaSize,
      artworkTop - sceneH / 2, contentW - metaSize * 2, regular, metaSize, MUTED);
  }

  // ── the products it was built from, below ─────────────────────────
  if (tiles.length > 0) {
    const gridTop = artworkTop - sceneH - unit * 0.035;
    const gridH = gridTop - artworkBottom;
    const cols = tileColumns(input.widthFt, input.heightFt, tiles.length);
    const rows = Math.ceil(tiles.length / cols);
    const gap = unit * 0.022;
    const cellW = (contentW - gap * (cols - 1)) / cols;
    const cellH = (gridH - gap * (rows - 1)) / rows;
    const capSize = Math.max(5, Math.min(metaSize, cellW / 13));
    const shotH = Math.max(cellH * 0.45, cellH - capSize * 3.4);

    const images = await Promise.all(tiles.map((tile) => embedImage(doc, tile.imageUrl)));

    tiles.forEach((tile, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const x = margin + col * (cellW + gap);
      const cellTop = gridTop - row * (cellH + gap);
      const shotY = cellTop - shotH;

      page.drawRectangle({ x, y: shotY, width: cellW, height: shotH, color: rgb(1, 1, 1), borderColor: HAIRLINE, borderWidth: 0.5 });

      const image = images[index];
      if (image) {
        const box = containedBox(image, x, shotY, cellW, shotH);
        page.drawImage(image, box);
      } else {
        const [r, g, b] = colorForTile(tile);
        page.drawRectangle({ x: x + 1, y: shotY + 1, width: cellW - 2, height: shotH - 2, color: rgb(r, g, b) });
      }

      let capY = shotY - capSize * 1.4;
      drawClipped(page, String(tile.role || '').toUpperCase(), x, capY, cellW, bold, capSize * 0.85, GOLD);
      capY -= capSize * 1.3;
      drawClipped(page, tile.name, x, capY, cellW, regular, capSize);

      const meta = [tile.brandName, tile.size].filter(Boolean).join(' · ');
      if (meta) {
        capY -= capSize * 1.25;
        drawClipped(page, meta, x, capY, cellW, regular, capSize * 0.9, MUTED);
      }
    });
  }

  // ── footer ────────────────────────────────────────────────────────
  if (footerLines.length > 0) {
    page.drawLine({
      start: { x: margin, y: artworkBottom - metaSize * 0.4 },
      end: { x: widthPt - margin, y: artworkBottom - metaSize * 0.4 },
      thickness: 0.5, color: HAIRLINE,
    });
    let footerY = artworkBottom - metaSize * 1.8;
    for (const line of footerLines) {
      drawClipped(page, line, margin, footerY, contentW, regular, metaSize * 0.9, MUTED);
      footerY -= metaSize * 1.5;
    }
  }

  return doc.save();
}
