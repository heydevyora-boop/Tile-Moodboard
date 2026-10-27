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

/** How much of the smaller material may touch the other before this is two materials, not a pattern. */
const EDGE_LIMIT = 0.55;

/** The smaller population has to be a real share of the picture, not speckle. */
const MINORITY_FLOOR = 0.08;

/** ...and the two have to be different colours, not two shades of one. */
const GAP_FLOOR = 0.15;

/** A band runs the full length of one edge: one reach near 1, the other small. */
const BAND_REACH = 0.25;
const BAND_SPAN = 0.9;

const FETCH_TIMEOUT_MS = 6000;
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
}

const KEPT = (reason: string): ScreenVerdict => ({
  ok: true, reason, gap: 0, minority: 0, apart: 0, edge: 1, touches: false, band: false,
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
  };
}

// Per-process, because the same twenty products are looked at on every
// generation and their pictures do not change between them.
const verdicts = new Map<string, ScreenVerdict>();
const samples = new Map<string, { data: Uint8ClampedArray; w: number; h: number } | null>();
const signatures = new Map<string, TileSignature | null>();

async function decode(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    const { createCanvas, loadImage } = await import('@napi-rs/canvas');
    const image = await loadImage(Buffer.from(buffer));
    const canvas = createCanvas(SAMPLE, SAMPLE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, SAMPLE, SAMPLE);
    return { data: ctx.getImageData(0, 0, SAMPLE, SAMPLE).data as unknown as Uint8ClampedArray, w: SAMPLE, h: SAMPLE };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The decoded sample, fetched at most once per picture per process. */
async function sampleOf(url: string): Promise<{ data: Uint8ClampedArray; w: number; h: number } | null> {
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
): Promise<Array<{ tile: T; of: T }>> {
  const signed = await Promise.all(tiles.map((t) => tileSignature(imageUrlOf(t.tileId))));
  const duplicates: Array<{ tile: T; of: T }> = [];
  const seen: Array<{ tile: T; signature: TileSignature }> = [];

  tiles.forEach((tile, i) => {
    const signature = signed[i];
    if (!signature) return;
    const match = seen.find((s) => sameSurface(s.signature, signature));
    if (match) duplicates.push({ tile, of: match.tile });
    else seen.push({ tile, signature });
  });

  return duplicates;
}

/** One picture's verdict. Anything unreadable is kept. */
export async function screenTileImage(url: string | null | undefined): Promise<ScreenVerdict> {
  if (!url || !/^https?:\/\//i.test(url)) return KEPT('no image to look at');

  const cached = verdicts.get(url);
  if (cached) return cached;

  const decoded = await sampleOf(url);
  const verdict = decoded ? measureSplit(decoded.data, decoded.w, decoded.h) : KEPT('could not read the image');
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
): Promise<{ kept: T[]; rejected: Array<{ tile: T; reason: string }> }> {
  const verdictList = await Promise.all(tiles.map((t) => screenTileImage(t.imageUrl)));

  const kept: T[] = [];
  const rejected: Array<{ tile: T; reason: string }> = [];
  tiles.forEach((tile, i) => {
    if (verdictList[i].ok) kept.push(tile);
    else rejected.push({ tile, reason: verdictList[i].reason });
  });

  while (kept.length < floor && rejected.length > 0) {
    kept.push(rejected.shift()!.tile);
  }

  return { kept, rejected };
}

/** Test seam: the cache would otherwise carry a verdict between cases. */
export function clearScreenCache(): void {
  verdicts.clear();
  samples.clear();
  signatures.clear();
}
