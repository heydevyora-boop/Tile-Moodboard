/**
 * The split-material screen, measured on the REAL swatches.
 *
 * fixtures/ holds the four product thumbnails from the two boards the
 * catalog owner reported: two captures that each hold two materials, and
 * two that hold one. They are the evidence this was built from, so they
 * are what it is tested against -- not something invented to agree with
 * it.
 *
 * The synthetic cases are the ones that must SURVIVE: a scattered decor
 * pattern and a border band both look split by a naive measure.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  measureSplit,
  screenTileImage,
  screenSlate,
  clearScreenCache,
  signatureOf,
  sameSurface,
  lookalikeRoles,
} from '@services/tileImageScreen.service';

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

const FIXTURES = path.join(__dirname, 'fixtures');
const SAMPLE = 48;

async function verdictOf(file: string) {
  const image = await loadImage(file);
  const canvas = createCanvas(SAMPLE, SAMPLE);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
  return measureSplit(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data as unknown as Uint8ClampedArray, SAMPLE, SAMPLE);
}

function scattered(bg: string, motif: string, file: string): string {
  const c = createCanvas(240, 240);
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = motif;
  let s = 7;
  const rand = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < 90; i += 1) {
    ctx.beginPath();
    ctx.arc(rand() * 240, rand() * 240, 4 + rand() * 9, 0, Math.PI * 2);
    ctx.fill();
  }
  fs.writeFileSync(file, c.toBuffer('image/png'));
  return file;
}

function band(file: string): string {
  const c = createCanvas(240, 240);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#E8DCC6'; ctx.fillRect(0, 0, 240, 240);
  ctx.fillStyle = '#B08D4E'; ctx.fillRect(0, 200, 240, 40);
  fs.writeFileSync(file, c.toBuffer('image/png'));
  return file;
}

function halves(file: string): string {
  const c = createCanvas(240, 240);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#6B4A2F'; ctx.fillRect(0, 0, 120, 240);
  ctx.fillStyle = '#E8E4DC'; ctx.fillRect(120, 0, 120, 240);
  fs.writeFileSync(file, c.toBuffer('image/png'));
  return file;
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'screen-'));

  // ── the two captures that must be refused ──────────────────────────
  const badDecore = await verdictOf(path.join(FIXTURES, 'bad-decore-0002.png'));
  const badBody = await verdictOf(path.join(FIXTURES, 'bad-colorbody-0004.png'));
  check('1. The brown/floral capture is refused', !badDecore.ok, badDecore);
  check('2. The grey/terracotta capture is refused', !badBody.ok, badBody);
  check('3. ...and each says what it saw', /two materials in one capture/.test(badDecore.reason)
    && /two materials in one capture/.test(badBody.reason), [badDecore.reason, badBody.reason]);

  // ── the two from the same boards that must be kept ─────────────────
  const goodBody = await verdictOf(path.join(FIXTURES, 'good-colorbody-0002.png'));
  const goodDecore = await verdictOf(path.join(FIXTURES, 'good-decore-0004.png'));
  check('4. The plain colourbody is kept', goodBody.ok, goodBody);
  check('5. The plain black decor is kept', goodDecore.ok, goodDecore);

  // ── the capture that defeated the first version ────────────────────
  //
  // A chevron of stone on a black ground. The black wraps the stone
  // symmetrically, so the two materials' CENTRES both land in the middle
  // and the measure this screen used to decide on saw nothing at all.
  const chevron = await verdictOf(path.join(FIXTURES, 'bad-chevron.png'));
  check('6. The chevron capture is refused', !chevron.ok, chevron);
  check('7. ...and the old measure really would have missed it',
    chevron.apart < 0.18, { apart: chevron.apart });

  // ── what must survive ──────────────────────────────────────────────
  const floral = await verdictOf(scattered('#F6F3EC', '#8A6A62', path.join(tmp, 'floral.png')));
  const terrazzo = await verdictOf(scattered('#EFE7DA', '#5A5651', path.join(tmp, 'terrazzo.png')));
  check('8. A scattered floral decor survives', floral.ok, floral);
  check('9. A terrazzo survives', terrazzo.ok, terrazzo);
  check('10. ...even though both hold two very different colours',
    floral.gap > 0.3 && terrazzo.gap > 0.3, [floral.gap, terrazzo.gap]);
  check('11. ...because a pattern puts both colours everywhere',
    floral.apart < 0.1 && terrazzo.apart < 0.1, [floral.apart, terrazzo.apart]);

  // ── the margin, on the measure that now decides ────────────────────
  const rejectedEdge = Math.max(badDecore.edge, badBody.edge, chevron.edge);
  const keptEdge = Math.min(floral.edge, terrazzo.edge);
  check('11b. Scattered decor and split captures do not overlap on edge',
    keptEdge > rejectedEdge, { rejectedEdge, keptEdge });
  check('11c. ...with room on both sides of the threshold (0.55)',
    0.55 - rejectedEdge > 0.1 && keptEdge - 0.55 > 0.1,
    { rejected: rejectedEdge, kept: keptEdge, margin: [0.55 - rejectedEdge, keptEdge - 0.55] });

  // ── a motif in the middle of its own tile is not two materials ─────
  const medallionFile = (() => {
    const c = createCanvas(240, 240);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#F2EADA'; ctx.fillRect(0, 0, 240, 240);
    ctx.fillStyle = '#2B5FA8';
    ctx.beginPath(); ctx.arc(120, 120, 62, 0, Math.PI * 2); ctx.fill();
    const file = path.join(tmp, 'medallion.png');
    fs.writeFileSync(file, c.toBuffer('image/png'));
    return file;
  })();
  const medallion = await verdictOf(medallionFile);
  check('11d. A centred medallion survives', medallion.ok, medallion);
  check('11e. ...and is kept because it never reaches the frame, being as clumped as a split',
    !medallion.touches && medallion.edge <= 0.55, medallion);

  const border = await verdictOf(band(path.join(tmp, 'band.png')));
  check('12. A border tile survives its stripe', border.ok, border);
  check('13. ...and is kept BY the band exemption, not by luck',
    border.band && border.apart > 0.18, border);

  // ── and the obvious case ───────────────────────────────────────────
  const split = await verdictOf(halves(path.join(tmp, 'halves.png')));
  check('14. A capture split down the middle is refused', !split.ok, split);

  // ── failing open ───────────────────────────────────────────────────
  clearScreenCache();
  check('15. A tile with no image is kept', (await screenTileImage(null)).ok);
  check('16. A non-http image is kept', (await screenTileImage('data:image/png;base64,xx')).ok);
  check('17. An unreachable image is kept',
    (await screenTileImage('http://127.0.0.1:9/none.png')).ok);
  check('18. ...and says so rather than claiming it looked',
    /could not read|no image/.test((await screenTileImage('http://127.0.0.1:9/none.png')).reason));

  // ── over a slate, end to end, over real HTTP ───────────────────────
  const served: Record<string, Buffer> = {
    '/bad1.png': fs.readFileSync(path.join(FIXTURES, 'bad-decore-0002.png')),
    '/bad2.png': fs.readFileSync(path.join(FIXTURES, 'bad-colorbody-0004.png')),
    '/good1.png': fs.readFileSync(path.join(FIXTURES, 'good-colorbody-0002.png')),
    '/good2.png': fs.readFileSync(path.join(FIXTURES, 'good-decore-0004.png')),
  };
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const body = served[(req.url || '').split('?')[0]];
    if (!body) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(8799, r));
  const base = 'http://127.0.0.1:8799';

  clearScreenCache();
  const slate = [
    { id: 'bad-1', imageUrl: `${base}/bad1.png` },
    { id: 'good-1', imageUrl: `${base}/good1.png` },
    { id: 'bad-2', imageUrl: `${base}/bad2.png` },
    { id: 'good-2', imageUrl: `${base}/good2.png` },
    { id: 'no-image', imageUrl: null },
  ];
  const screened = await screenSlate(slate, 0);
  check('19. Both bad captures are out of the slate',
    !screened.kept.some((t) => t.id.startsWith('bad')), screened.kept.map((t) => t.id));
  check('20. Both good ones stay', screened.kept.some((t) => t.id === 'good-1') && screened.kept.some((t) => t.id === 'good-2'));
  check('21. A product with no picture stays', screened.kept.some((t) => t.id === 'no-image'));
  check('22. The refusals are reported with their reason',
    screened.rejected.length === 2 && screened.rejected.every((r) => /two materials/.test(r.reason)),
    screened.rejected.map((r) => [r.tile.id, r.reason]));

  // ── and it must never empty the slate ──────────────────────────────
  clearScreenCache();
  const allBad = await screenSlate([
    { id: 'b1', imageUrl: `${base}/bad1.png` },
    { id: 'b2', imageUrl: `${base}/bad2.png` },
  ], 2);
  check('23. A catalog of nothing but bad captures still returns a slate',
    allBad.kept.length === 2, allBad.kept.map((t) => t.id));

  // ── and must not fetch the same picture twice ──────────────────────
  clearScreenCache();
  const before = hits;
  await screenSlate(slate, 0);
  const firstPass = hits - before;
  await screenSlate(slate, 0);
  check('24. Each picture is fetched once, then remembered',
    hits - before === firstPass, { firstPass, total: hits - before });

  // ── TWO PRODUCTS, ONE SURFACE ──────────────────────────────────────
  //
  // The reported board used the same plain grey as its base AND its
  // border: two rows, two product codes, two sizes, one surface. These
  // three are that board's own thumbnails.
  const sig = async (file: string) => {
    const image = await loadImage(path.join(FIXTURES, file));
    const canvas = createCanvas(SAMPLE, SAMPLE);
    canvas.getContext('2d').drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return signatureOf(canvas.getContext('2d').getImageData(0, 0, SAMPLE, SAMPLE).data as unknown as Uint8ClampedArray, SAMPLE, SAMPLE);
  };
  const base15 = await sig('twin-base-0015.png');
  const border18 = await sig('twin-border-0018.png');
  const decor05 = await sig('decor-0005.png');

  check('25. The base and the border are seen as one surface', sameSurface(base15, border18), { base15, border18 });
  check('26. The decor is not the same surface as the base', !sameSurface(base15, decor05));
  check('27. ...nor as the border', !sameSurface(border18, decor05));

  // Different products that really are different must stay different.
  const flat = (hex: string, file: string) => {
    const c = createCanvas(240, 240);
    const ctx = c.getContext('2d');
    ctx.fillStyle = hex; ctx.fillRect(0, 0, 240, 240);
    fs.writeFileSync(file, c.toBuffer('image/png'));
    return file;
  };
  const sigOfFile = async (file: string) => {
    const image = await loadImage(file);
    const canvas = createCanvas(SAMPLE, SAMPLE);
    canvas.getContext('2d').drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return signatureOf(canvas.getContext('2d').getImageData(0, 0, SAMPLE, SAMPLE).data as unknown as Uint8ClampedArray, SAMPLE, SAMPLE);
  };
  const ivory = await sigOfFile(flat('#F6F3EC', path.join(tmp, 'ivory.png')));
  const charcoal = await sigOfFile(flat('#3A3733', path.join(tmp, 'charcoal.png')));
  const sand = await sigOfFile(flat('#D9C7A6', path.join(tmp, 'sand.png')));
  check('28. Ivory and charcoal are not one surface', !sameSurface(ivory, charcoal));
  check('29. Ivory and sand are not one surface', !sameSurface(ivory, sand));
  check('30. A picture is the same surface as itself', sameSurface(ivory, ivory));
  check('31. The floral decor is not the same as a flat ivory', !sameSurface(decor05, ivory));

  // ── over a combination, which is where it has to act ───────────────
  const served2: Record<string, Buffer> = {
    '/base15.png': fs.readFileSync(path.join(FIXTURES, 'twin-base-0015.png')),
    '/border18.png': fs.readFileSync(path.join(FIXTURES, 'twin-border-0018.png')),
    '/decor05.png': fs.readFileSync(path.join(FIXTURES, 'decor-0005.png')),
  };
  Object.assign(served, served2);
  clearScreenCache();

  const urls: Record<string, string | null> = {
    't-base': `${base}/base15.png`,
    't-highlight': `${base}/decor05.png`,
    't-border': `${base}/border18.png`,
    't-noimage': null,
  };
  const combo = [
    { role: 'base', tileId: 't-base' },
    { role: 'highlight', tileId: 't-highlight' },
    { role: 'border', tileId: 't-border' },
  ];
  const dupes = await lookalikeRoles(combo, (id) => urls[id]);
  check('32. The repeated surface is found', dupes.length === 1, dupes.map((d) => [d.tile.role, d.of.role]));
  check('33. ...and it is the LATER role that is named, not the base',
    dupes[0] && dupes[0].tile.role === 'border' && dupes[0].of.role === 'base', dupes[0]);

  const kept = combo.filter((t) => !dupes.some((d) => d.tile === t));
  check('34. The board keeps its base and its highlight',
    kept.map((t) => t.role).join(',') === 'base,highlight', kept.map((t) => t.role));

  clearScreenCache();
  const noDupes = await lookalikeRoles([
    { role: 'base', tileId: 't-base' },
    { role: 'highlight', tileId: 't-highlight' },
  ], (id) => urls[id]);
  check('35. A board of two real surfaces loses nothing', noDupes.length === 0, noDupes);

  clearScreenCache();
  const blind = await lookalikeRoles([
    { role: 'base', tileId: 't-noimage' },
    { role: 'border', tileId: 't-noimage2' },
  ], () => null);
  check('36. Two products with no picture are never called the same',
    blind.length === 0, blind);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
