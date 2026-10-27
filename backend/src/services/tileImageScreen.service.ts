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
 * WHAT IT MEASURES, and why each part is needed. The measurements below
 * were calibrated against the four swatches from the boards the catalog
 * owner reported -- two bad, two good -- plus a patterned decor tile and
 * a border tile, which must survive:
 *
 *                        gap    minority  apart   band
 *   plain colourbody     0.007   0.267    0.065   -      keep
 *   plain black decor    0.442   0.002    0.000   -      keep
 *   SPLIT brown/floral   0.547   0.444    0.302   no     reject
 *   SPLIT grey/terracotta 0.206  0.119    0.357   no     reject
 *   scattered floral     0.486   0.296    0.032   -      keep
 *   scattered terrazzo   0.544   0.296    0.032   -      keep
 *   border band          0.349   0.167    0.354   yes    keep
 *
 * `apart` is what carries the decision: two materials sit in two PLACES,
 * while a pattern puts both colours everywhere, so a pattern's two
 * populations share a centre and a split's do not. `gap` and `minority`
 * stop a near-uniform tile tripping it on noise. And `band` is the
 * exemption a border tile needs: its stripe sits as far off centre as a
 * split does, but it runs the full length of one edge and no further,
 * where a bad crop's second material reaches part way along two.
 *
 * It fails OPEN. A picture that cannot be fetched, decoded or measured is
 * kept, because "we could not look" is not evidence of anything, and a
 * screen that empties the catalog is worse than the problem it solves.
 */

const SAMPLE = 48;

/** How far the two populations' centres may sit apart before this is two materials. */
const APART_LIMIT = 0.18;

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
  apart: number;
  band: boolean;
}

const KEPT = (reason: string): ScreenVerdict => ({ ok: true, reason, gap: 0, minority: 0, apart: 0, band: false });

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

  // How far the smaller material reaches, per row and per column. A row
  // counts only if a tenth of it belongs to that material, so a scatter
  // of stray pixels is not a reach.
  const smaller = nA <= nB ? 0 : 1;
  const rows = new Array(h).fill(0);
  const cols = new Array(w).fill(0);
  for (let i = 0; i < n; i += 1) {
    if (side(i) !== smaller) continue;
    rows[Math.floor(i / w)] += 1;
    cols[i % w] += 1;
  }
  const rowReach = rows.filter((c) => c / w >= 0.1).length / h;
  const colReach = cols.filter((c) => c / h >= 0.1).length / w;
  const band = Math.min(rowReach, colReach) <= BAND_REACH && Math.max(rowReach, colReach) >= BAND_SPAN;

  const split = apart >= APART_LIMIT && minority >= MINORITY_FLOOR && gap >= GAP_FLOOR && !band;

  return {
    ok: !split,
    reason: split
      ? `two materials in one capture (apart ${apart.toFixed(2)}, minority ${minority.toFixed(2)}, gap ${gap.toFixed(2)})`
      : 'one material',
    gap,
    minority,
    apart,
    band,
  };
}

// Per-process, because the same twenty products are screened on every
// generation and their pictures do not change between them.
const verdicts = new Map<string, ScreenVerdict>();

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

/** One picture's verdict. Anything unreadable is kept. */
export async function screenTileImage(url: string | null | undefined): Promise<ScreenVerdict> {
  if (!url || !/^https?:\/\//i.test(url)) return KEPT('no image to look at');

  const cached = verdicts.get(url);
  if (cached) return cached;

  const decoded = await decode(url);
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
}
