/**
 * The mood board PDF: real page dimensions, real images, no stretching.
 *
 * Every assertion reads the PRODUCED FILE back with pdf-lib rather than
 * trusting the inputs -- a page size is only correct if a reader sees it
 * that way.
 */
import { PDFDocument } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';
import * as http from 'http';
import * as zlib from 'zlib';
import { renderMoodBoardPdf, tileColumns, MoodBoardPdfTile } from '@services/moodBoardPdf.service';
import { BOARD_SIZES_FT, exportMoodBoardPdfSchema } from '@validators/moodBoard.validators';

/**
 * The words a reader actually sees. PDF content streams are
 * Flate-compressed, so this inflates them and pulls the literals out of
 * the text-showing operators.
 */
function visibleText(pdf: Buffer): string {
  const out: string[] = [];
  const marker = Buffer.from('stream');
  let at = 0;

  while ((at = pdf.indexOf(marker, at)) !== -1) {
    let start = at + marker.length;
    if (pdf[start] === 0x0d) start += 1;
    if (pdf[start] === 0x0a) start += 1;
    const end = pdf.indexOf(Buffer.from('endstream'), start);
    if (end === -1) break;

    try {
      const body = zlib.inflateSync(pdf.subarray(start, end)).toString('latin1');
      // pdf-lib writes the operand of Tj as a HEX string, not a literal:
      //   <4341534120444520415552554D> Tj
      for (const m of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) {
        const raw = Buffer.from(m[1], 'hex');
        out.push(raw[0] === 0xfe && raw[1] === 0xff ? raw.subarray(2).swap16().toString('utf16le') : raw.toString('latin1'));
      }
      // Literal form, in case a future font encoding uses it.
      for (const m of body.matchAll(/\(((?:\\.|[^\\()])*)\)\s*Tj/g)) {
        out.push(m[1].replace(/\\([()\\])/g, '$1'));
      }
    } catch {
      // Not a Flate stream (an embedded JPEG, say) -- nothing to read.
    }
    at = end + 9;
  }

  return out.join(' ');
}

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass += 1;
    console.log(`OK   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

/** A real PNG/JPEG of known proportions, served over HTTP like the catalog's are. */
function imageBytes(width: number, height: number, mime: 'image/png' | 'image/jpeg' | 'image/webp'): Buffer {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#b79a6e';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#2f4a3c';
  ctx.fillRect(0, 0, width / 2, height / 2);
  if (mime === 'image/jpeg') return canvas.toBuffer('image/jpeg');
  if (mime === 'image/webp') return canvas.toBuffer('image/webp');
  return canvas.toBuffer('image/png');
}

async function main() {
  // ── a local image host, so nothing in this test reaches the network ──
  const served: Record<string, { body: Buffer; type: string }> = {
    '/scene.png': { body: imageBytes(1024, 576, 'image/png'), type: 'image/png' },
    '/tile.jpg': { body: imageBytes(600, 1200, 'image/jpeg'), type: 'image/jpeg' },
    '/tile.webp': { body: imageBytes(800, 800, 'image/webp'), type: 'image/webp' },
  };
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    const hit = served[(req.url || '').split('?')[0]];
    if (!hit) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': hit.type });
    res.end(hit.body);
  });
  await new Promise<void>((resolve) => server.listen(8791, resolve));
  const base = 'http://127.0.0.1:8791';

  const tiles: MoodBoardPdfTile[] = [
    { role: 'base', name: 'Elite Whitebody', brandName: 'Mozart', size: '600x1200', imageUrl: `${base}/tile.jpg` },
    { role: 'highlight', name: 'Elite Decore', brandName: 'Mozart', size: '600x600', imageUrl: `${base}/tile.webp` },
    { role: 'border', name: 'Bull Nose Moulding', brandName: 'Mozart', size: '75x300', imageUrl: `${base}/missing.png` },
  ];
  const input = {
    boardName: 'Warm Ivory Minimalist',
    brief: 'Spa-like bathroom, warm tones',
    grout: 'Ivory Matte',
    widthFt: 4,
    heightFt: 4,
    sceneImageUrl: `${base}/scene.png`,
    tiles,
  };

  // ── 1. exact physical page size, read back from the file ───────────
  for (const [w, h] of BOARD_SIZES_FT) {
    const bytes = await renderMoodBoardPdf({ ...input, widthFt: w, heightFt: h });
    const page = (await PDFDocument.load(bytes)).getPage(0);
    const expectedW = w * 12 * 72;
    const expectedH = h * 12 * 72;
    check(
      `1. ${w}ft x ${h}ft is ${expectedW}x${expectedH}pt in the file`,
      Math.abs(page.getWidth() - expectedW) < 0.01 && Math.abs(page.getHeight() - expectedH) < 0.01,
      { got: [page.getWidth(), page.getHeight()], expected: [expectedW, expectedH] },
    );
  }

  const square = await renderMoodBoardPdf(input);
  const squareDoc = await PDFDocument.load(square);

  // ── 2. one page, never a stray blank one ───────────────────────────
  check('2. Exactly one page, with no trailing blank', squareDoc.getPageCount() === 1, squareDoc.getPageCount());

  // ── 3. the conversion the brief specifies ──────────────────────────
  const strip = await renderMoodBoardPdf({ ...input, widthFt: 10, heightFt: 4 });
  const stripPage = (await PDFDocument.load(strip)).getPage(0);
  check('3. 1 ft = 72 pt per foot of length (10ft = 8640pt)', stripPage.getWidth() === 10 * 864, stripPage.getWidth());
  check('4. ...and the page is landscape when the board is', stripPage.getWidth() > stripPage.getHeight());

  const column = (await PDFDocument.load(await renderMoodBoardPdf({ ...input, widthFt: 2, heightFt: 4 }))).getPage(0);
  check('5. A 2x4 board is portrait', column.getHeight() > column.getWidth());

  // ── 6. the images really are embedded, at their own proportions ────
  const text = Buffer.from(square).toString('latin1');
  const widths = [...text.matchAll(/\/Width (\d+)/g)].map((m) => Number(m[1]));
  const heights = [...text.matchAll(/\/Height (\d+)/g)].map((m) => Number(m[1]));
  check('6. Three images are embedded (scene, jpg tile, webp tile)', widths.length === 3, { widths, heights });
  check('7. The scene keeps its own 1024x576 pixels', widths.includes(1024) && heights.includes(576), { widths, heights });
  check('8. The portrait tile keeps its own 600x1200 pixels', widths.includes(600) && heights.includes(1200), { widths, heights });
  check('9. A WebP is re-encoded rather than dropped', widths.includes(800) && heights.includes(800), { widths, heights });
  check('10. DCTDecode survives for the JPEG (not re-encoded needlessly)', text.includes('DCTDecode'));

  // ── 11. a dead image URL costs a swatch, not the board ─────────────
  check('11. An unreachable tile image does not fail the export', square.byteLength > 2000, square.byteLength);
  const noScene = await renderMoodBoardPdf({ ...input, sceneImageUrl: undefined });
  check('12. A board with no scene still renders', (await PDFDocument.load(noScene)).getPageCount() === 1);
  const noTiles = await renderMoodBoardPdf({ ...input, tiles: [] });
  check('13. A board with no tiles still renders', (await PDFDocument.load(noTiles)).getPageCount() === 1);

  // ── 14. the details the client has to read ─────────────────────────
  //
  // Content streams are Flate-compressed, so the drawn words are not in
  // the raw bytes. Inflate every stream and read what the page actually
  // shows -- the only honest way to assert "the product details are on
  // the board".
  const drawn = visibleText(Buffer.from(square));
  check('14a. The board name is drawn on the page', drawn.includes('Warm Ivory Minimalist'), drawn.slice(0, 400));
  check('14b. The chosen size is printed on the board', drawn.includes('4 ft') && drawn.includes('ft'), drawn.slice(0, 400));
  check('14c. Every product name is drawn', ['Elite Whitebody', 'Elite Decore', 'Bull Nose Moulding'].every((n) => drawn.includes(n)), drawn.slice(0, 600));
  check('14d. Product dimensions are drawn', drawn.includes('600x1200') && drawn.includes('75x300'), drawn.slice(0, 600));
  check('14e. The brand is drawn', drawn.includes('Mozart'));
  check('14f. Each role is labelled', ['BASE', 'HIGHLIGHT', 'BORDER'].every((r) => drawn.includes(r)), drawn.slice(0, 600));
  check('14g. The grout is carried into the footer', drawn.includes('Ivory Matte'));
  const meta = await PDFDocument.load(square);
  check('15. The title carries the board name', (meta.getTitle() || '').includes('Warm Ivory Minimalist'), meta.getTitle());

  // ── 16. layout follows the aspect ratio ────────────────────────────
  check('16. A long 10x4 strip lays 3 products in one row', tileColumns(10, 4, 3) === 3, tileColumns(10, 4, 3));
  check('17. A 2x4 column stacks them one per row', tileColumns(2, 4, 3) === 1, tileColumns(2, 4, 3));
  check('18. A square 4x4 uses two columns', tileColumns(4, 4, 3) === 2, tileColumns(4, 4, 3));
  check('19. Columns never exceed the number of products', tileColumns(10, 4, 2) <= 2, tileColumns(10, 4, 2));
  check('20. A single product is never split across columns', tileColumns(10, 4, 1) === 1);

  // ── 21. the size whitelist ─────────────────────────────────────────
  const body = { boardName: 'B', widthFt: 4, heightFt: 4, tiles: [] };
  check('21. An offered size is accepted', exportMoodBoardPdfSchema.safeParse(body).success);
  check('22. An arbitrary size is refused', !exportMoodBoardPdfSchema.safeParse({ ...body, widthFt: 7, heightFt: 3 }).success);
  check('23. ...including a free-text one', !exportMoodBoardPdfSchema.safeParse({ ...body, widthFt: 'big' }).success);
  check('24. All nine offered sizes pass the validator',
    BOARD_SIZES_FT.every(([w, h]) => exportMoodBoardPdfSchema.safeParse({ ...body, widthFt: w, heightFt: h }).success));
  check('25. More than eight products is refused',
    !exportMoodBoardPdfSchema.safeParse({ ...body, tiles: Array.from({ length: 9 }, () => ({ role: 'base', name: 'x' })) }).success);

  // ── 26. no image is fetched twice per export ───────────────────────
  const before = requests;
  await renderMoodBoardPdf(input);
  check('26. One export fetches each image once (4 URLs, 1 of them 404)', requests - before === 4, requests - before);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
