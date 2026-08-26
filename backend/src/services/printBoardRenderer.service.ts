import { PDFDocument, PDFPage, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import { toPoints } from '@utils/printDimensions';
import { colorForTile } from '@utils/tileColorSwatches';

export interface RenderTile {
  role: string;
  name: string;
  brandName?: string;
  size?: string | null;
  colorTone?: string | null;
}

export interface RenderInput {
  boardName: string;
  clientBrief: string;
  groutRecommendation: string;
  tiles: RenderTile[];
  format: string;
  layout: 'HERO_IMAGE' | 'TILE_GRID' | 'SIDE_BY_SIDE' | 'CASSETTE_STYLE';
  widthValue: number;
  heightValue: number;
  unit: 'FT' | 'IN' | 'CM' | 'MM';
  dpi: number;
}

// Approximate swatch colors by keyword match against colorTone/name — this
// is a labeled placeholder, not a photo. See the README for why: reliably
// fetching and decoding arbitrary remote/local tile images (Drive URLs,
// varying formats) for embedding was more risk than this module's scope
// justified; every swatch is clearly text-labeled with the real product
// name, brand, and size, so nothing about which actual tile is meant is
// ambiguous — a print shop operator or store owner reviewing the PDF
// before sending it to production has everything they need to verify it.
function drawWrappedText(page: PDFPage, text: string, x: number, y: number, maxWidth: number, font: PDFFont, size: number, color = rgb(0.13, 0.12, 0.09)): number {
  const words = text.split(/\s+/);
  let line = '';
  let cursorY = y;
  const lineHeight = size * 1.35;

  for (const word of words) {
    const trial = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) > maxWidth && line) {
      page.drawText(line, { x, y: cursorY, size, font, color });
      cursorY -= lineHeight;
      line = word;
    } else {
      line = trial;
    }
  }
  if (line) {
    page.drawText(line, { x, y: cursorY, size, font, color });
    cursorY -= lineHeight;
  }
  return cursorY;
}

function drawSwatch(page: PDFPage, tile: RenderTile, x: number, y: number, w: number, h: number, regularFont: PDFFont, boldFont: PDFFont) {
  const [r, g, b] = colorForTile(tile);
  page.drawRectangle({ x, y: y - h, width: w, height: h, color: rgb(r, g, b), borderColor: rgb(0.13, 0.12, 0.09), borderWidth: 0.75 });

  const labelSize = Math.max(7, Math.min(11, w / 14));
  const labelY = y - h - labelSize - 4;
  page.drawText(tile.role.toUpperCase(), { x, y: labelY, size: labelSize * 0.8, font: boldFont, color: rgb(0.68, 0.51, 0.31) });
  drawWrappedText(page, tile.name, x, labelY - labelSize - 2, w, regularFont, labelSize);
  if (tile.brandName || tile.size) {
    const meta = [tile.brandName, tile.size].filter(Boolean).join(' \u00b7 ');
    page.drawText(meta, { x, y: labelY - labelSize * 3, size: labelSize * 0.8, font: regularFont, color: rgb(0.47, 0.44, 0.36) });
  }
}

/**
 * Renders a real PDF at the exact requested physical size. Layout is
 * genuinely different per enum value, not a single template with a
 * label swapped — HERO_IMAGE gives the base tile the most visual weight
 * (matches how a showroom cassette panel is actually composed), TILE_GRID
 * lays every tile out evenly (best for a reference/catalog-style board),
 * SIDE_BY_SIDE splits base vs. accent tiles left/right, and CASSETTE_STYLE
 * uses a horizontal banner strip matching a physical cassette panel's
 * proportions.
 */
export async function renderPrintBoardPdf(input: RenderInput): Promise<Uint8Array> {
  const widthPt = toPoints(input.widthValue, input.unit);
  const heightPt = toPoints(input.heightValue, input.unit);

  const doc = await PDFDocument.create();
  doc.setTitle(`${input.boardName} \u2014 Casa de Aurum`);
  doc.setProducer('Casa de Aurum Internal Tool');

  const page = doc.addPage([widthPt, heightPt]);
  const regularFont = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = Math.max(18, Math.min(widthPt, heightPt) * 0.04);
  const contentWidth = widthPt - margin * 2;
  let cursorY = heightPt - margin;

  page.drawText('CASA DE AURUM', { x: margin, y: cursorY - 14, size: 16, font: boldFont, color: rgb(0.11, 0.1, 0.08) });
  page.drawText(input.boardName, { x: margin, y: cursorY - 32, size: 12, font: regularFont, color: rgb(0.47, 0.44, 0.36) });
  cursorY -= 52;

  const availableHeight = cursorY - margin - 90;

  if (input.layout === 'HERO_IMAGE') {
    const base = input.tiles.find((t) => t.role === 'base');
    const others = input.tiles.filter((t) => t.role !== 'base');
    const heroHeight = availableHeight * 0.62;
    if (base) drawSwatch(page, base, margin, cursorY, contentWidth, heroHeight, regularFont, boldFont);
    cursorY -= heroHeight + 46;

    const stripW = (contentWidth - (others.length - 1) * 12) / Math.max(1, others.length);
    others.forEach((t, i) => drawSwatch(page, t, margin + i * (stripW + 12), cursorY, stripW, availableHeight * 0.28, regularFont, boldFont));
  } else if (input.layout === 'SIDE_BY_SIDE') {
    const base = input.tiles.filter((t) => t.role === 'base');
    const rest = input.tiles.filter((t) => t.role !== 'base');
    const colW = (contentWidth - 20) / 2;
    base.forEach((t, i) => drawSwatch(page, t, margin, cursorY - i * (availableHeight / 2), colW, availableHeight * 0.85, regularFont, boldFont));
    rest.forEach((t, i) => drawSwatch(page, t, margin + colW + 20, cursorY - i * (availableHeight / Math.max(1, rest.length)), colW, availableHeight / Math.max(1, rest.length) - 10, regularFont, boldFont));
  } else if (input.layout === 'CASSETTE_STYLE') {
    const stripW = (contentWidth - (input.tiles.length - 1) * 10) / Math.max(1, input.tiles.length);
    input.tiles.forEach((t, i) => drawSwatch(page, t, margin + i * (stripW + 10), cursorY, stripW, availableHeight * 0.9, regularFont, boldFont));
  } else {
    const perRow = Math.min(3, input.tiles.length) || 1;
    const cellW = (contentWidth - (perRow - 1) * 14) / perRow;
    const rowH = availableHeight / Math.ceil(input.tiles.length / perRow) - 14;
    input.tiles.forEach((t, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      drawSwatch(page, t, margin + col * (cellW + 14), cursorY - row * (rowH + 46), cellW, rowH, regularFont, boldFont);
    });
  }

  const footerY = margin + 68;
  page.drawLine({ start: { x: margin, y: footerY + 14 }, end: { x: widthPt - margin, y: footerY + 14 }, thickness: 0.5, color: rgb(0.75, 0.71, 0.62) });
  drawWrappedText(page, `Grout: ${input.groutRecommendation || 'Not specified'}`, margin, footerY, contentWidth, regularFont, 9);
  drawWrappedText(page, `Brief: ${input.clientBrief}`, margin, footerY - 16, contentWidth, regularFont, 8, rgb(0.47, 0.44, 0.36));

  const specs = `${input.format} \u00b7 ${input.widthValue}${input.unit.toLowerCase()} x ${input.heightValue}${input.unit.toLowerCase()} \u00b7 ${input.dpi} DPI \u00b7 Casa de Aurum Internal Tool`;
  page.drawText(specs, { x: margin, y: margin, size: 7, font: regularFont, color: rgb(0.6, 0.57, 0.5) });

  return doc.save();
}
