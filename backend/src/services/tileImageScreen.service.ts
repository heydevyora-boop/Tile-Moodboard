/**
 * Keeps split-material captures out of mood boards.
 *
 * Extraction is not the problem and is not touched. A catalog page
 * sometimes yields a crop holding TWO materials -- a brown field meeting
 * a floral panel, a grey tile with the neighbouring terracotta caught in
 * the corner. Those are real rows with real images, so nothing downstream
 * had any reason to prefer a clean swatch over them, and boards came back
 * built from them.
 *
 * This looks at the pixels and says whether the picture is one material
 * or two. It runs on the candidate slate, before the model ever sees it.
 *
 * WHAT IT MEASURES, and why each part is needed. Calibrated against the
 * captures from the boards the catalog owner reported -- including a
 * chevron of stone on a black ground, which the first version of this
 * let through -- plus the decor tiles that must survive:
 *
 *                         gap   minority  edge   touches band
 *   plain colourbody      0.007  0.267   0.698    -       -    keep
 *   plain black decor     0.442  0.002   1.000    -       -    keep
 *   floral decor          0.165  0.219   0.728    -       -    keep
 *   plain modulo base     0.210  0.005   1.000    -       -    keep
 *   SPLIT brown/floral    0.547  0.444   0.244   yes     no   REJECT
 *   SPLIT grey/terracotta 0.206  0.119   0.411   yes     no   REJECT
 *   CHEVRON on black      0.298  0.360   0.188   yes     no   REJECT
 *   scattered floral      0.486  0.296   0.654    -       -    keep
 *   scattered terrazzo    0.544  0.296   0.653    -       -    keep
 *   border band           0.349  0.167   0.281    -      yes   keep
 *   centred medallion     0.556  0.210   0.140    no      -    keep
 *
 * `edge` is what carries the decision: how much of the smaller material
 * touches the other one. A scattered pattern is nearly all edge, because
 * every speck has the field around it. Two materials meeting are a few
 * big pieces, so only their outline touches.
 *
 * It replaced an earlier measure of how far the two materials' CENTRES
 * sat apart, which the chevron defeated: the black wraps the stone
 * symmetrically, so both centres land in the middle and that measure saw
 * nothing. `apart` is still reported, because it is useful when reading a
 * verdict, but it no longer decides anything.
 *
 * `gap` and `minority` stop a near-uniform tile tripping on its own
 * noise. And two exemptions keep real decor out of the net:
 *
 *   band     a border's stripe is clumped, but runs the full length of
 *            ONE edge and no further
 *   touches  a medallion is clumped too, but sits enclosed in its tile
 *            and never reaches the frame, where two materials in a bad
 *            crop both run off it
 *
 * It fails OPEN. A picture that cannot be fetched, decoded or measured is
 * kept, because "we could not look" is not evidence of anything, and a
 * screen that empties the catalog is worse than the problem it solves.
 */

const SAMPLE = 48;

/**
 * The wordmark screen reads at a higher resolution than the split
 * screen: letterforms are strokes, and a stroke is gone at 48px.
 */
const FINE = 128;

/**
 * A WORDMARK is three or more marks of similar height sitting on one
 * baseline, drawn with ONE stroke weight. That last part is what a
 * typeface is, and it is what separates a printed word from a repeating
 * motif -- a pattern's shapes are solid, a letter's are strokes.
 *
 * These are set WELL inside the gap rather than at it, for the reason
 * given in the header: the nearest decor measured 0.152 / 0.142, so a
 * rule drawn at the midpoint would be a coin toss on the next catalog.
 * Drawn here it catches the plate the owner reported with room to spare
 * and cannot reach their floral or tropical tiles. It will also miss a
 * fainter wordmark; that is the trade, and it is the right way round.
 */
const WORD_GLYPHS = 3;
const WORD_STROKE = 0.13;
const WORD_STROKE_EVENNESS = 0.13;

/** How much of the smaller material may touch the other before this is two materials, not a pattern. */
const EDGE_LIMIT = 0.55;

/** The smaller population has to be a real share of the picture, not speckle. */
const MINORITY_FLOOR = 0.08;

/** ...and the two have to be different colours, not two shades of one. */
const GAP_FLOOR = 0.15;

/** A band runs the full length of one edge: one reach near 1, the other small. */
const BAND_REACH = 0.25;
const BAND_SPAN = 0.9;

/**
 * HOW THE SCREEN WENT BLIND.
 *
 * screenSlate fetched the whole slate with one Promise.all -- EIGHTY
 * simultaneous requests to drive.google.com, each given six seconds.
 * Google throttles a burst like that, so most of them failed or timed
 * out; every failure fails open, silently, and the split captures this
 * file exists to stop walked straight into the boards. The measure was
 * never wrong: the two captures the owner reported are both rejected by
 * it on sight. It simply never got to look at them.
 *
 * So the fetching is paced instead of flung: a few at a time, longer to
 * answer, and one retry for a request that times out or errors -- which
 * is what a throttled host wants.
 */
const FETCH_TIMEOUT_MS = 12_000;
const FETCH_AT_ONCE = 6;
const FETCH_ATTEMPTS = 2;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

export interface ScreenVerdict {
  ok: boolean;
  reason: string;
  gap: number;
  minority: number;
  /** Reported for reading a verdict; it does not decide. */
  apart: number;
  /** The share of the smaller material that touches the other one. */
  edge: number;
  /** Whether the smaller material reaches the frame. */
  touches: boolean;
  band: boolean;
  /** Marks on the longest shared baseline. */
  word: number;
  /** Their stroke width, as a share of their height. */
  stroke: number;
  /** How evenly that stroke width is shared, 0 = one weight throughout. */
  evenness: number;
}

const KEPT = (reason: string): ScreenVerdict => ({
  ok: true, reason, gap: 0, minority: 0, apart: 0, edge: 1, touches: false, band: false,
  word: 0, stroke: 1, evenness: 1,
});

/** Everything this decides from, given the raw pixels of a square sample. */
export function measureSplit(data: Uint8ClampedArray, w: number, h: number): ScreenVerdict {
  const n = w * h;
  if (n === 0) return KEPT('empty');

  // Which channel separates this picture best? Grey against terracotta is
  // nearly invisible in brightness and obvious in red, so the cut is made
  // on whichever channel actually varies rather than on luminance by habit.
  const mean = [0, 0, 0];
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) mean[k] += data[i * 4 + k] / n;
  const variance = [0, 0, 0];
  for (let i = 0; i < n; i += 1) for (let k = 0; k < 3; k += 1) variance[k] += (data[i * 4 + k] - mean[k]) ** 2 / n;
  const ch = variance.indexOf(Math.max(...variance));

  // Otsu's cut: the threshold that most separates the two populations on
  // that channel. No seeding and no randomness, so the same picture always
  // gets the same answer.
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i += 1) hist[data[i * 4 + ch]] += 1;
  let total = 0;
  for (let v = 0; v < 256; v += 1) total += v * hist[v];
  let sumB = 0; let countB = 0; let best = -1; let cut = 0;
  for (let v = 0; v < 256; v += 1) {
    countB += hist[v];
    if (countB === 0) continue;
    const countF = n - countB;
    if (countF === 0) break;
    sumB += v * hist[v];
    const between = countB * countF * ((sumB / countB) - ((total - sumB) / countF)) ** 2;
    if (between > best) { best = between; cut = v; }
  }

  // Describe the two sides, in colour and in space.
  const side = (i: number) => (data[i * 4 + ch] <= cut ? 0 : 1);
  const sum = [[0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0]];
  for (let i = 0; i < n; i += 1) {
    const s = side(i);
    sum[s][0] += data[i * 4];
    sum[s][1] += data[i * 4 + 1];
    sum[s][2] += data[i * 4 + 2];
    sum[s][3] += i % w;
    sum[s][4] += Math.floor(i / w);
    sum[s][5] += 1;
  }
  const nA = sum[0][5]; const nB = sum[1][5];
  if (!nA || !nB) return KEPT('one population');

  const gap = Math.sqrt(
    (sum[0][0] / nA - sum[1][0] / nB) ** 2
    + (sum[0][1] / nA - sum[1][1] / nB) ** 2
    + (sum[0][2] / nA - sum[1][2] / nB) ** 2,
  ) / (255 * Math.sqrt(3));
  const minority = Math.min(nA, nB) / n;
  const apart = Math.sqrt(
    (sum[0][3] / nA - sum[1][3] / nB) ** 2 + (sum[0][4] / nA - sum[1][4] / nB) ** 2,
  ) / Math.sqrt(w * w + h * h);

  // The shape of the smaller material: how much of it touches the other
  // one, whether it reaches the frame, and how far it runs per row and
  // per column. A row counts toward the reach only if a tenth of it
  // belongs to that material, so a scatter of stray pixels is not a run.
  const smaller = nA <= nB ? 0 : 1;
  const rows = new Array(h).fill(0);
  const cols = new Array(w).fill(0);
  let smallCount = 0;
  let onEdge = 0;
  let touches = false;
  for (let i = 0; i < n; i += 1) {
    if (side(i) !== smaller) continue;
    smallCount += 1;
    const x = i % w;
    const y = Math.floor(i / w);
    rows[y] += 1;
    cols[x] += 1;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
    if (
      x === 0 || y === 0 || x === w - 1 || y === h - 1
      || side(i - 1) !== smaller || side(i + 1) !== smaller
      || side(i - w) !== smaller || side(i + w) !== smaller
    ) onEdge += 1;
  }
  const edge = smallCount ? onEdge / smallCount : 1;
  const rowReach = rows.filter((c) => c / w >= 0.1).length / h;
  const colReach = cols.filter((c) => c / h >= 0.1).length / w;
  const band = Math.min(rowReach, colReach) <= BAND_REACH && Math.max(rowReach, colReach) >= BAND_SPAN;

  const split = minority >= MINORITY_FLOOR
    && gap >= GAP_FLOOR
    && edge <= EDGE_LIMIT
    && touches
    && !band;

  return {
    ok: !split,
    reason: split
      ? `two materials in one capture (edge ${edge.toFixed(2)}, minority ${minority.toFixed(2)}, gap ${gap.toFixed(2)})`
      : 'one material',
    gap,
    minority,
    apart,
    edge,
    touches,
    band,
    // Filled in by screen() below, which asks the wordmark question of
    // the same picture. measureSplit answers only its own.
    word: 0,
    stroke: 1,
    evenness: 1,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// A word printed on the capture
//
// The owner's catalog yielded a brand plate as a product: a stone ground
// with "urvi (TM)" set across it in orange. It is not a tile, and it was
// reaching boards.
//
// Two measures were tried and thrown away before this one, both recorded
// here so neither gets tried again:
//
//   saturated ink on a grey ground -- rejected Moroccan blue and a cobalt
//   border outright. It keyed on COLOUR, and colour is exactly what a
//   decor tile is entitled to have.
//
//   marks on a shared baseline -- a repeating pattern puts its motifs on
//   shared baselines too, so terrazzo, floral and tropical all read as
//   words.
//
// What a typeface has and a pattern does not is ONE STROKE WEIGHT across
// a row of differently-shaped marks. Measured over the fixtures:
//
//                        glyphs  stroke  evenness   verdict
//   urvi brand plate        7     0.042    0.115    REJECT
//   "MOZART" plate          6     0.117    0.069    REJECT
//   "onery" wordmark        3     0.138    0.176    kept (missed)
//   floral decor            7     0.152    0.142    keep
//   tropical leaves        13     0.183    0.196    keep
//   moroccan blue          16     0.276    0.051    keep
//   terrazzo                8      --       --      keep (no baseline)
//   cobalt border           0      --       --      keep
//   every plain body        0      --       --      keep
//
// There is no clean gap between 0.138 and 0.152, so the thresholds are
// set well below the nearest decor rather than between them. That misses
// the fainter "onery" plate on purpose: a screen that takes a catalog's
// floral and tropical tiles away is a worse failure than one that lets a
// second brand plate through, and the owner sees the plate while they
// would never see the quietly missing decor.
// ─────────────────────────────────────────────────────────────────────────

interface Blob {
  x0: number; x1: number; y0: number; y1: number; area: number; perimeter: number;
}

/** Marks that stand clear of the grain, grouped into connected blobs. */
function inkBlobs(data: Uint8ClampedArray, w: number, h: number): Blob[] {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    lum[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }

  // Each pixel against its own surroundings, not against the whole
  // picture: a dark letter on light stone and a light letter on dark
  // stone are the same thing, and a vignette is neither.
  const r = Math.round(w / 12);
  const background = new Float32Array(n);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy += 2) {
        for (let dx = -r; dx <= r; dx += 2) {
          const yy = y + dy;
          const xx = x + dx;
          if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
          sum += lum[yy * w + xx];
          count += 1;
        }
      }
      background[y * w + x] = sum / count;
    }
  }

  const apart = new Float32Array(n);
  for (let i = 0; i < n; i += 1) apart[i] = Math.abs(lum[i] - background[i]);
  const ranked = Array.from(apart).sort((a, b) => a - b);
  const cut = Math.max(26, ranked[Math.floor(n * 0.9)]);

  const ink = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) ink[i] = apart[i] >= cut ? 1 : 0;

  const seen = new Int32Array(n).fill(-1);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < n; start += 1) {
    if (!ink[start] || seen[start] >= 0) continue;
    const id = blobs.length;
    let x0 = w; let x1 = 0; let y0 = h; let y1 = 0; let area = 0; let perimeter = 0;
    stack.length = 0;
    stack.push(start);
    seen[start] = id;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w;
      const y = Math.floor(p / w);
      area += 1;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of neighbours) {
        if (q < 0 || !ink[q]) { perimeter += 1; continue; }
        if (seen[q] < 0) { seen[q] = id; stack.push(q); }
      }
    }
    blobs.push({ x0, x1, y0, y1, area, perimeter });
  }
  return blobs;
}

/** Is there a word printed across this capture? */
export function measureWordmark(data: Uint8ClampedArray, w: number, h: number): {
  word: number; stroke: number; evenness: number; printed: boolean;
} {
  const n = w * h;
  const glyphs = inkBlobs(data, w, h)
    .map((b) => {
      const bw = b.x1 - b.x0 + 1;
      const bh = b.y1 - b.y0 + 1;
      // Stroke width from area and outline: a letter is a thin ribbon,
      // a motif is a solid shape, and this says which at any scale.
      return { ...b, bw, bh, fill: b.area / (bw * bh), stroke: b.perimeter ? (2 * b.area / b.perimeter) / bh : 1 };
    })
    .filter((g) => (
      g.bh >= h * 0.06 && g.bh <= h * 0.55
      && g.bw >= w * 0.015 && g.bw <= w * 0.45
      && g.bw / g.bh >= 0.08 && g.bw / g.bh <= 2.2
      && g.fill >= 0.12 && g.fill <= 0.85
      && g.area >= n * 0.0008
    ));

  let word = 0;
  let stroke = 1;
  let evenness = 1;
  for (const anchor of glyphs) {
    const anchorHeight = anchor.bh;
    const row = glyphs.filter((g) => (
      Math.abs(g.y1 - anchor.y1) <= anchorHeight * 0.45
      && g.bh >= anchorHeight * 0.45 && g.bh <= anchorHeight * 1.8
    ));
    if (row.length < WORD_GLYPHS) continue;

    const widths = row.map((g) => g.stroke);
    const mean = widths.reduce((a, b) => a + b, 0) / widths.length;
    const spread = Math.sqrt(widths.reduce((a, v) => a + (v - mean) ** 2, 0) / widths.length) / mean;
    // The most even row wins: that is the one most likely to be type.
    if (row.length > word || (row.length === word && spread < evenness)) {
      word = row.length;
      stroke = mean;
      evenness = spread;
    }
  }

  return {
    word,
    stroke,
    evenness,
    printed: word >= WORD_GLYPHS && stroke <= WORD_STROKE && evenness <= WORD_STROKE_EVENNESS,
  };
}

// Per-process, because the same twenty products are looked at on every
// generation and their pictures do not change between them.
const verdicts = new Map<string, ScreenVerdict>();
const samples = new Map<string, Sample | null>();
const signatures = new Map<string, TileSignature | null>();

/**
 * One fetch, two sizes. The split screen and the fingerprint read the
 * coarse one; the wordmark screen needs the fine one, because a
 * letter's stroke is gone at 48px.
 */
interface Sample {
  data: Uint8ClampedArray;
  w: number;
  h: number;
  fine: { data: Uint8ClampedArray; w: number; h: number };
}

/** One attempt at the bytes. Null means "not this time", which may be worth retrying. */
async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      // Drive's thumbnail endpoint answers a plain client differently
      // from a browser; this is the shape the <img> tag that already
      // displays these images sends.
      headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' },
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Runs tasks a few at a time rather than all at once. */
async function paced<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      out[i] = await run(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

async function decode(url: string): Promise<Sample | null> {
  try {
    let buffer: ArrayBuffer | null = null;
    for (let attempt = 0; attempt < FETCH_ATTEMPTS && !buffer; attempt += 1) {
      buffer = await fetchBytes(url);
    }
    if (!buffer || buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(buffer));

    const draw = (size: number) => {
      const canvas = createCanvas(size, size);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(image, 0, 0, size, size);
      return { data: ctx.getImageData(0, 0, size, size).data as unknown as Uint8ClampedArray, w: size, h: size };
    };

    const coarse = draw(SAMPLE);
    return { ...coarse, fine: draw(FINE) };
  } catch {
    return null;
  }
}

/** The decoded sample, fetched at most once per picture per process. */
async function sampleOf(url: string): Promise<Sample | null> {
  if (samples.has(url)) return samples.get(url)!;
  const decoded = await decode(url);
  samples.set(url, decoded);
  return decoded;
}

// ─────────────────────────────────────────────────────────────────────────
// Two products, one surface
//
// A board came back with the same plain grey tile as its base AND as its
// border -- different rows, different product codes, different sizes, the
// same surface. Nothing caught it: validateCombinations refuses a repeated
// tileId, and these were two ids.
//
// So the comparison has to be of the pictures. A coarse 8x8 brightness
// hash says whether the two have the same STRUCTURE, and the mean colour
// says whether they are the same COLOUR. Both have to agree before two
// products are called one surface, because either alone is far too eager:
// every plain tile in the catalog shares a flat structure, and ivory and
// cream share a colour.
// ─────────────────────────────────────────────────────────────────────────

export interface TileSignature {
  /** 64 bits of "is this cell brighter than the average", as a string. */
  hash: string;
  /** Mean colour, 0..1 per channel. */
  mean: [number, number, number];
}

/** How many of the 64 cells may disagree and still be the same surface. */
const HASH_SLACK = 6;

/** ...and how far apart their colours may be, 0..1. */
const COLOUR_SLACK = 0.05;

export function signatureOf(data: Uint8ClampedArray, w: number, h: number): TileSignature {
  const cells = new Array(64).fill(0);
  const counts = new Array(64).fill(0);
  let mean: [number, number, number] = [0, 0, 0];

  for (let i = 0; i < w * h; i += 1) {
    const x = Math.min(7, Math.floor(((i % w) / w) * 8));
    const y = Math.min(7, Math.floor((Math.floor(i / w) / h) * 8));
    const lum = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114);
    cells[y * 8 + x] += lum;
    counts[y * 8 + x] += 1;
    mean[0] += data[i * 4]; mean[1] += data[i * 4 + 1]; mean[2] += data[i * 4 + 2];
  }

  const n = w * h;
  mean = [mean[0] / n / 255, mean[1] / n / 255, mean[2] / n / 255];

  const averages = cells.map((sum, i) => (counts[i] ? sum / counts[i] : 0));
  const overall = averages.reduce((a, b) => a + b, 0) / 64;
  return { hash: averages.map((v) => (v >= overall ? '1' : '0')).join(''), mean };
}

/** Do these two pictures show the same surface? */
export function sameSurface(a: TileSignature, b: TileSignature): boolean {
  let different = 0;
  for (let i = 0; i < a.hash.length; i += 1) if (a.hash[i] !== b.hash[i]) different += 1;
  if (different > HASH_SLACK) return false;

  const colour = Math.sqrt(
    (a.mean[0] - b.mean[0]) ** 2 + (a.mean[1] - b.mean[1]) ** 2 + (a.mean[2] - b.mean[2]) ** 2,
  ) / Math.sqrt(3);
  return colour <= COLOUR_SLACK;
}

/** One picture's fingerprint, or null when there is nothing to look at. */
export async function tileSignature(url: string | null | undefined): Promise<TileSignature | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  if (signatures.has(url)) return signatures.get(url)!;

  const sample = await sampleOf(url);
  const signature = sample ? signatureOf(sample.data, sample.w, sample.h) : null;
  signatures.set(url, signature);
  return signature;
}

/**
 * Finds the roles in one combination that show a surface an earlier role
 * already showed. The first use of a surface keeps its place -- so a base
 * stays the base -- and the later one is named for the caller to drop.
 *
 * A product with no readable picture is never called a duplicate: two
 * unknowns are not evidence of sameness.
 */
export async function lookalikeRoles<T extends { role: string; tileId: string }>(
  tiles: T[],
  imageUrlOf: (tileId: string) => string | null | undefined,
): Promise<{ duplicates: Array<{ tile: T; of: T }>; unread: T[] }> {
  const signed = await Promise.all(tiles.map((t) => tileSignature(imageUrlOf(t.tileId))));
  const duplicates: Array<{ tile: T; of: T }> = [];
  const unread: T[] = [];
  const seen: Array<{ tile: T; signature: TileSignature }> = [];

  tiles.forEach((tile, i) => {
    const signature = signed[i];
    if (!signature) { unread.push(tile); return; }
    const match = seen.find((s) => sameSurface(s.signature, signature));
    if (match) duplicates.push({ tile, of: match.tile });
    else seen.push({ tile, signature });
  });

  return { duplicates, unread };
}

/** Both questions, asked of one decoded picture. */
function screen(sample: Sample): ScreenVerdict {
  const split = measureSplit(sample.data, sample.w, sample.h);
  const mark = measureWordmark(sample.fine.data, sample.fine.w, sample.fine.h);
  const verdict: ScreenVerdict = { ...split, word: mark.word, stroke: mark.stroke, evenness: mark.evenness };

  if (!verdict.ok) return verdict;
  if (!mark.printed) return verdict;

  return {
    ...verdict,
    ok: false,
    reason: `a word is printed across this capture (${mark.word} marks, stroke ${mark.stroke.toFixed(2)}, evenness ${mark.evenness.toFixed(2)}) -- a brand plate, not a tile`,
  };
}

/** One picture's verdict. Anything unreadable is kept. */
export async function screenTileImage(url: string | null | undefined): Promise<ScreenVerdict> {
  if (!url || !/^https?:\/\//i.test(url)) return KEPT('no image to look at');

  const cached = verdicts.get(url);
  if (cached) return cached;

  const decoded = await sampleOf(url);
  const verdict = decoded
    ? screen(decoded)
    : KEPT('could not read the image');
  verdicts.set(url, verdict);
  return verdict;
}

/**
 * Screens a slate, and refuses to empty it.
 *
 * If screening would leave fewer than `floor` products, the rejected ones
 * come back in best-first order until it does not. A catalog whose every
 * capture is odd still produces a board -- with its least odd pictures.
 */
export async function screenSlate<T extends { id: string; imageUrl?: string | null }>(
  tiles: T[],
  floor = 6,
): Promise<{ kept: T[]; rejected: Array<{ tile: T; reason: string }>; unread: T[] }> {
  const verdictList = await paced(tiles, FETCH_AT_ONCE, (t) => screenTileImage(t.imageUrl));

  const kept: T[] = [];
  const rejected: Array<{ tile: T; reason: string }> = [];
  // A PRODUCT THE SCREEN COULD NOT LOOK AT.
  //
  // It is kept, because "we could not look" is not evidence -- and that
  // was silent, which is how eighty throttled fetches turned the whole
  // screen off without a word. Counted here so the caller can say it.
  const unread: T[] = [];
  tiles.forEach((tile, i) => {
    if (/could not read the image/.test(verdictList[i].reason)) unread.push(tile);
    if (verdictList[i].ok) kept.push(tile);
    else rejected.push({ tile, reason: verdictList[i].reason });
  });

  while (kept.length < floor && rejected.length > 0) {
    kept.push(rejected.shift()!.tile);
  }

  return { kept, rejected, unread };
}

/** Test seam: the cache would otherwise carry a verdict between cases. */
export function clearScreenCache(): void {
  verdicts.clear();
  samples.clear();
  signatures.clear();
}
