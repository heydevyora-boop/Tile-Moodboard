import { prisma } from '@db/connection';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { normalizeDriveImageUrl } from './referenceImages.service';
import { ListTilesQuery } from '@validators/tileRecommendation.validators';

// ─────────────────────────────────────────────────────────────────────────
// Style profiles — styles (LUXURY, SUBTLE, etc.) aren't a field on Tile;
// they're a taste profile that maps onto real tile attributes (finish,
// color, type). This table is the mapping. Kept separate from the design
// rules text itself: those are the *narrative* the owner writes for the
// AI, this is the *structured* heuristic this deterministic engine uses.
// ─────────────────────────────────────────────────────────────────────────

interface StyleProfile {
  finishes: string[];
  colorFamilies: string[];
  types: string[];
}

const STYLE_PROFILES: Record<string, StyleProfile> = {
  LUXURY: { finishes: ['glossy', 'polished'], colorFamilies: ['gold', 'dark', 'cool-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },
  SUBTLE: { finishes: ['matte'], colorFamilies: ['warm-neutral', 'cool-neutral'], types: ['BASE'] },
  BOLD: { finishes: ['glossy', 'textured'], colorFamilies: ['dark', 'earth', 'blue', 'green'], types: ['ACCENT', 'HIGHLIGHTER'] },
  TRADITIONAL: { finishes: ['matte', 'textured'], colorFamilies: ['earth', 'warm-neutral'], types: ['BASE', 'BORDER'] },
  FEMININE: { finishes: ['glossy', 'polished'], colorFamilies: ['rose', 'gold', 'warm-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },

  // The three labels the mood board wizard actually sends.
  //
  // frontend/mood-board.html puts the chosen PALETTE in the request's
  // `style` field -- "Warm Neutral", "Cool Grey", "High Contrast" -- and
  // none of the five keys above is one of them. scoreStyle looks the
  // label up, finds nothing, and returns zero for every tile, so the
  // palette the client picked has been deciding nothing at all: measured,
  // a fully classified bathroom tile scores 42 under "Warm Neutral" and
  // 82 under "SUBTLE", purely because one of the two names is in this
  // table. Forty points of discrimination, silently discarded on every
  // single generation.
  //
  // Each entry is read off that palette's own spec line in the wizard,
  // not invented here: "BEIGE / SAND / TRAVERTINE", "ASH / SILK / SLATE",
  // "IVORY / CHARCOAL / BRASS". The finish vocabulary is the one the Tile
  // rows actually store, which is what scoreStyle compares against -- not
  // the wizard's separate finish step, which goes into the brief text.
  // Kept although the wizard no longer offers them: boards saved while
  // these were the options still carry one of these three in `style`,
  // and reopening such a board must rank the same way it did when it
  // was made.
  'WARM NEUTRAL': { finishes: ['matte', 'textured'], colorFamilies: ['warm-neutral', 'earth'], types: ['BASE'] },
  'COOL GREY': { finishes: ['matte', 'polished'], colorFamilies: ['cool-neutral'], types: ['BASE'] },
  'HIGH CONTRAST': { finishes: ['glossy', 'polished'], colorFamilies: ['cool-neutral', 'dark', 'gold'], types: ['HIGHLIGHTER', 'ACCENT'] },

  // THE DESIGN THEMES the wizard now sends, read off each theme's own
  // swatches and spec line in frontend/mood-board.html rather than
  // invented here. Without an entry a theme looks up to nothing and
  // scores zero for every tile, which is how the three palettes above
  // silently decided nothing for months -- so every theme offered in the
  // UI has a row here.
  //
  // "Let De'vyora Decide" deliberately has none. It is the absence of a
  // theme, so the scorer stays neutral and the model chooses.
  BRITISH: { finishes: ['matte', 'polished'], colorFamilies: ['green', 'dark', 'warm-neutral'], types: ['BASE', 'BORDER'] },
  'ROMAN TOUCH': { finishes: ['matte', 'textured'], colorFamilies: ['warm-neutral', 'earth'], types: ['BASE', 'LARGE_FORMAT_BASE'] },
  FLORAL: { finishes: ['glossy', 'matte'], colorFamilies: ['rose', 'green', 'warm-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },
  TROPICAL: { finishes: ['glossy', 'textured'], colorFamilies: ['green', 'blue', 'earth'], types: ['ACCENT', 'HIGHLIGHTER'] },
  // The terracotta accent in this theme's palette is why 'earth' is here.
  GEOMETRICAL: { finishes: ['matte', 'glossy'], colorFamilies: ['cool-neutral', 'dark', 'earth'], types: ['HIGHLIGHTER', 'BORDER'] },
  METALLIC: { finishes: ['glossy', 'polished'], colorFamilies: ['gold', 'dark', 'cool-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },
  RUSTIC: { finishes: ['matte', 'textured'], colorFamilies: ['earth', 'warm-neutral'], types: ['BASE', 'BORDER'] },
  MOROCCAN: { finishes: ['glossy', 'textured'], colorFamilies: ['blue', 'green', 'gold'], types: ['HIGHLIGHTER', 'ACCENT', 'BORDER'] },
  'BLACK & WHITE': { finishes: ['polished', 'matte'], colorFamilies: ['cool-neutral', 'dark'], types: ['BASE', 'HIGHLIGHTER'] },
};

// ─────────────────────────────────────────────────────────────────────────
// Color families — groups related color-tone keywords so "Ivory" and
// "Champagne" can be recognized as related without requiring an exact
// string match, while staying far more conservative than free-text
// similarity (no fuzzy matching, no false positives across families).
// ─────────────────────────────────────────────────────────────────────────

const COLOR_FAMILIES: Record<string, string[]> = {
  'warm-neutral': ['ivory', 'cream', 'beige', 'champagne', 'tan'],
  'cool-neutral': ['grey', 'gray', 'white', 'bianco', 'silver'],
  dark: ['black', 'charcoal', 'espresso'],
  earth: ['brown', 'terracotta', 'rust', 'bronze', 'copper'],
  rose: ['rose', 'pink', 'blush'],
  gold: ['gold', 'brass', 'champagne'],
  blue: ['blue', 'navy', 'teal'],
  green: ['green', 'emerald', 'sage'],
};

function familiesFor(colorTone: string | null | undefined): string[] {
  if (!colorTone) return [];
  const lower = colorTone.toLowerCase();
  return Object.entries(COLOR_FAMILIES)
    .filter(([, keywords]) => keywords.some((k) => lower.includes(k)))
    .map(([family]) => family);
}

// ─────────────────────────────────────────────────────────────────────────
// Crop shape
//
// A catalog page yields good captures and bad ones -- half a tile, a
// furniture shot, a sliver of a page. The bad ones are not marked as bad
// anywhere, so they sat in the pool with exactly the standing of a clean
// swatch, and a model choosing between products it cannot see picked
// them as readily as anything else.
//
// The one thing the row already knows is the SHAPE of the crop it came
// from -- imageBbox, written by the extraction pipeline -- and the shape
// the product claims to be, in `size`. A 600x1200 tile whose capture is
// square is not a picture of that tile. That disagreement is the signal.
//
// Deliberately bounded, and deliberately silent when it cannot measure:
// a listello really is 75x300, so its 1:4 crop agrees with its own size
// and costs it nothing, and a tile with no size or no bbox is not
// punished for data nobody recorded. It is a penalty, never a filter --
// a catalog whose every crop is odd must still produce a board.
// ─────────────────────────────────────────────────────────────────────────

const CROP_SHAPE_PENALTY = 30;

/** How far a crop may differ from its product's declared shape before it counts against it. */
const CROP_SHAPE_TOLERANCE = 0.4;

/** "600x1200", "600 X 1200 mm", "600×1200" -> 2. Null when it does not parse. */
export function declaredAspect(size: string | null | undefined): number | null {
  if (!size) return null;
  const m = String(size).match(/(\d{2,5})\s*[x\u00D7*]\s*(\d{2,5})/i);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!(w > 0 && h > 0)) return null;
  return Math.max(w, h) / Math.min(w, h);
}

/** The aspect of the region this image was cut from. Null when unknown. */
export function cropAspect(bbox: unknown): number | null {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const nums = bbox.map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const w = Math.abs(nums[2] - nums[0]);
  const h = Math.abs(nums[3] - nums[1]);
  if (!(w > 0 && h > 0)) return null;
  return Math.max(w, h) / Math.min(w, h);
}

/**
 * Does this capture look like the product it claims to be?
 *
 * Both numbers have to be known for this to say anything at all.
 */
export function scoreCropShape(tile: TileForRanking): { points: number; reasons: string[] } {
  const declared = declaredAspect(tile.size);
  const crop = cropAspect(tile.imageBbox);
  if (declared === null || crop === null) return { points: 0, reasons: [] };

  const drift = Math.abs(crop - declared) / declared;
  if (drift <= CROP_SHAPE_TOLERANCE) {
    return { points: 0, reasons: ['Capture matches the product\u2019s own proportions'] };
  }

  return {
    points: -CROP_SHAPE_PENALTY,
    reasons: [`Capture is ${crop.toFixed(1)}:1 where the product is ${declared.toFixed(1)}:1`],
  };
}

export interface TileForRanking {
  id: string;
  name: string;
  brandName?: string;
  size?: string | null;
  finish?: string | null;
  type: string;
  colorTone?: string | null;
  bestRoom?: string | null;
  productCode?: string | null;
  // When this tile was extracted. Supplied by getRecommendedTiles from
  // the Tile row's own timestamps -- never inferred from array order,
  // product code or anything else that only looks like an ordering.
  // Optional so rankTiles stays callable without them, in which case
  // no tile is labelled as being from the latest extraction.
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  // [x0, y0, x1, y1] of the region this image was cut from the catalog
  // page. Supplied by getRecommendedTiles from the Tile row; optional, so
  // rankTiles stays callable without it and the shape signal simply says
  // nothing.
  imageBbox?: unknown;
  // Carried so the slate can be screened on what the picture actually
  // shows; see tileImageScreen.service.ts. Nothing in ranking reads it.
  imageUrl?: string | null;
}

export interface RankingCriteria {
  room?: string;
  style?: string;
  colorTone?: string;
  /**
   * Varies which of the EQUALLY-scoring tiles lead the list.
   *
   * Omit it and the order is the alphabetical one this always had, so
   * nothing that does not ask for variety is affected.
   */
  varietySeed?: number;
}

export interface RankedTile extends TileForRanking {
  score: number;
  matchReasons: string[];
  /** How many catalog rows matched the filters, before the pool limit cut them. */
  poolMatched?: number;
  // True for the tiles from the newest extraction in this pool. It adds
  // nothing to the score -- it is carried out of the scorer purely so the
  // prompt can explain their blank attributes; see formatTileForPrompt
  // in promptBuilder.
  fromLatestExtraction: boolean;
  // Only populated by getRecommendedTiles() (rankTiles() alone has no
  // notion of catalogs) -- see sourceGroupKey() below.
  catalogGroup?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Extraction recency — a label, not a preference
//
// Recency used to add RECENCY_BONUS points to a tile's score, so a
// freshly extracted product won near-ties against older stock. That was
// put there to fix the opposite complaint: a new catalog was losing
// every board. It over-corrected. A bonus for having been written to
// the database recently is not a design argument, and it let a newer
// tile outrank an older one that suited the theme better.
//
// So recency scores nothing now. What remains is the LABEL: which tiles
// came from the newest extraction, carried through to the prompt so it
// can explain why their finish, colour and room are blank. masterTileSync
// writes what the extraction pipeline sends -- a product code, an image,
// a collection -- and nothing else, so a new tile arrives unclassified.
// Blank means "not recorded", never "unsuitable", and the prompt says so.
//
// Old and new are therefore ranked on the same terms: room fit, theme
// fit, colour fit. Neither cohort is given points the other cannot earn.
// ─────────────────────────────────────────────────────────────────────────

// How wide "the latest extraction" is. One sync run writes its rows over
// seconds to minutes, so a window keeps a batch together instead of
// labelling only whichever row of it happened to be written last.
const RECENCY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The moment this tile was last written, or null when unknown. */
export function extractionTime(tile: TileForRanking): number | null {
  const stamps = [tile.updatedAt, tile.createdAt]
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((value) => Number.isFinite(value));

  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/** Whether this tile belongs to the newest extraction in its pool. Scores nothing. */
function isFromLatestExtraction(tile: TileForRanking, newest: number | null): boolean {
  if (newest === null) return false;

  const when = extractionTime(tile);
  if (when === null) return false;

  return newest - when <= RECENCY_WINDOW_MS;
}

function scoreRoom(tile: TileForRanking, room: string | undefined): { points: number; reasons: string[] } {
  if (!room) return { points: 0, reasons: [] };
  if (!tile.bestRoom) return { points: 8, reasons: ['Versatile — no specific room restriction'] };
  if (tile.bestRoom.toLowerCase() === room.toLowerCase()) return { points: 40, reasons: [`Exact room match: ${tile.bestRoom}`] };
  return { points: -10, reasons: [] };
}

function scoreStyle(tile: TileForRanking, style: string | undefined): { points: number; reasons: string[] } {
  if (!style) return { points: 0, reasons: [] };
  const profile = STYLE_PROFILES[style.toUpperCase()];
  if (!profile) return { points: 0, reasons: [] };

  let points = 0;
  const reasons: string[] = [];

  if (tile.finish && profile.finishes.includes(tile.finish.toLowerCase())) {
    points += 15;
    reasons.push(`${tile.finish} finish matches ${style} style`);
  }
  const tileFamilies = familiesFor(tile.colorTone);
  if (tileFamilies.some((f) => profile.colorFamilies.includes(f))) {
    points += 15;
    reasons.push(`${tile.colorTone} fits the ${style.toLowerCase()} palette`);
  }
  if (profile.types.includes(tile.type)) {
    points += 10;
    reasons.push(`${tile.type} role suits ${style} combinations`);
  }

  return { points, reasons };
}

function scoreColor(tile: TileForRanking, requestedColor: string | undefined): { points: number; reasons: string[] } {
  if (!requestedColor || !tile.colorTone) return { points: 0, reasons: [] };
  if (tile.colorTone.toLowerCase() === requestedColor.toLowerCase()) {
    return { points: 30, reasons: [`Exact color match: ${tile.colorTone}`] };
  }
  const tileFamilies = familiesFor(tile.colorTone);
  const requestedFamilies = familiesFor(requestedColor);
  if (tileFamilies.some((f) => requestedFamilies.includes(f))) {
    return { points: 18, reasons: [`${tile.colorTone} is in the same color family as ${requestedColor}`] };
  }
  return { points: 0, reasons: [] };
}

/**
 * Scores and sorts a pool of tiles against room/style/color criteria.
 * Filtering (in-stock, brand) happens before this — ranking is a soft
 * scoring pass, not a hard filter, so an otherwise-good tile with a
 * room mismatch still shows up, just lower — useful for browsing ("show
 * me what's close") as well as feeding a stricter downstream consumer
 * that only wants the top N.
 */
/**
 * A stable shuffle value for one tile under one seed.
 *
 * Not Math.random: a tile has to keep the same value for the whole of a
 * single ranking pass, or the sort comparator is inconsistent and the
 * result is undefined. This is a cheap hash of the id and the seed --
 * fixed within a pass, different between passes.
 */
function tieBreak(id: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (Math.imul(hash ^ id.charCodeAt(i), 0x01000193) >>> 0);
  }
  return hash;
}

export function rankTiles(tiles: TileForRanking[], criteria: RankingCriteria): RankedTile[] {
  // "Latest" is measured against this pool's own newest row, so it means
  // the same thing whether the database holds two catalogs or two
  // hundred, and needs no wall-clock threshold to keep current.
  const stamps = tiles.map(extractionTime).filter((value): value is number => value !== null);
  const newest = stamps.length > 0 ? Math.max(...stamps) : null;

  const ranked = tiles.map((tile) => {
    const room = scoreRoom(tile, criteria.room);
    const style = scoreStyle(tile, criteria.style);
    const color = scoreColor(tile, criteria.colorTone);
    const latest = isFromLatestExtraction(tile, newest);
    const crop = scoreCropShape(tile);
    const baseTieBreak = tile.type === 'BASE' ? 2 : 0;

    return {
      ...tile,
      score: room.points + style.points + color.points + crop.points + baseTieBreak,
      matchReasons: [...room.reasons, ...style.reasons, ...color.reasons, ...crop.reasons],
      fromLatestExtraction: latest,
    };
  });

  // SCORE DECIDES. THE TIE-BREAK MUST NOT ALWAYS PICK THE SAME TILE.
  //
  // This sorted by score and then by NAME, which made the whole pool
  // deterministic: one catalog and one brief produced byte-identical
  // candidates in byte-identical order on every generation, so the model
  // was shown the same products every time and picked the same ones. A
  // catalog of four hundred tiles behaved like a catalog of eighty.
  //
  // Tiles that score the same are, by this engine's own measure, equally
  // good for the brief -- so which of them goes first is free, and
  // spending it on the alphabet bought nothing. With a seed it buys
  // variety across generations, and with none it is the old alphabetical
  // order exactly, so every existing caller and test is unaffected.
  //
  // Only TIES move. A better-scoring tile still outranks a worse one,
  // every time.
  const seed = criteria.varietySeed;
  if (seed === undefined) {
    return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }
  return ranked.sort(
    (a, b) => b.score - a.score || tieBreak(a.id, seed) - tieBreak(b.id, seed) || a.name.localeCompare(b.name),
  );
}

export interface RecommendationFilter {
  brandId?: string;
  type?: string;
  room?: string;
  style?: string;
  /** Varies which of the EQUALLY-scoring tiles lead the pool. See rankTiles. */
  varietySeed?: number;
  colorTone?: string;
  limit?: number;
}

// ─────────────────────────────────────────────────────────────────────────
// Source diversity — ranking alone decides the whole prompt pool, so once
// many catalogs are loaded the top N can legitimately all come from a
// single catalog. That structurally prevents the AI from ever mixing
// products across catalogs, however good the prompt is.
// ─────────────────────────────────────────────────────────────────────────

interface TileSource {
  id: string;
  brandId: string;
  catalogId?: string | null;
  collection?: string | null;
  productCode?: string | null;
}

/**
 * Stable "which catalog did this tile come from" key.
 *
 * catalogId covers UI-uploaded tiles. Tiles synced from the MASTER sheet
 * have no Catalog row at all — masterTileSync.service.ts leaves catalogId
 * null — so fall back to collection, then to the product code with its
 * trailing image index stripped: make_product_id() in the extraction
 * pipeline builds "<BRAND>-<CATALOG>-<INDEX>", making that prefix the
 * catalog identity. brandId is the last resort, so a tile always lands in
 * a real group rather than becoming a group of one that dodges the spread.
 */
function sourceGroupKey(tile: TileSource): string {
  if (tile.catalogId) return `catalog:${tile.catalogId}`;
  if (tile.collection) return `collection:${tile.collection}`;

  const codePrefix = tile.productCode?.match(/^(.+)-\d{3,}$/)?.[1];
  if (codePrefix) return `code:${codePrefix}`;

  return `brand:${tile.brandId}`;
}

// ─────────────────────────────────────────────────────────────────────────
// A note on repeat extractions of the same product
//
// The same physical product can legitimately exist as several Tile rows --
// once per extraction it has appeared in -- and those rows' stored images
// can differ. An earlier version of this module collapsed them to a single
// "current" copy here, chosen by extraction recency, before ranking ran.
// That is deliberately gone: it removed a real, separately-stored tile from
// the candidate set on an age rule, before the scoring below ever saw it.
//
// Every row that passes the filters is now a candidate, and the existing
// room/style/colour/type scoring alone decides which one belongs in a
// board. Recency is not a ranking signal here in any form, not even as a
// tie-break -- a newer extraction has to earn its place on merit like any
// other tile, and an older one is never displaced merely for being older.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Fill the pool by taking each source's best tile, then each source's
 * second best, and so on, instead of taking the global top N.
 *
 * Groups are visited in the order their best-ranked tile appeared, so the
 * strongest catalogs still lead. Spreading this way scales with however
 * many catalogs exist: with a handful loaded each contributes many tiles,
 * with a hundred loaded the pool becomes each catalog's top match for this
 * brief — which is both wider and better than the deep tail of a single
 * catalog that a plain slice would have taken.
 *
 * A single source degenerates to exactly the slice this replaces, and the
 * pool size never changes — only which tiles fill it.
 */
// ─────────────────────────────────────────────────────────────────────────
// Role coverage
//
// A board is one base plus at least one decorated piece. The pool was
// chosen purely on score, which does not know that -- so when the best
// twenty products happened all to be plain, the model was asked for a
// highlight from a list that contained nothing decorated.
//
// It cannot answer that honestly. Either it nominates a plain tile as
// the highlight (the base and the highlight end up the same kind of
// thing, which is what the catalog owner sees), or it returns a board
// with no highlight at all. And validateCombinations cannot catch the
// first case: its guard only runs when the pool HELD a decorated
// product, precisely so a catalog with none can still produce a board.
//
// So the slate is required to carry both kinds, whenever the catalog has
// both. Nothing is invented and nothing jumps the queue on merit: the
// best decorated products take the places of the weakest plain ones,
// and only as many as the shape of a board actually needs.
// ─────────────────────────────────────────────────────────────────────────

const DECORATED_TYPES = new Set(['HIGHLIGHTER', 'ACCENT', 'BORDER']);

/** How many decorated products a slate must carry, when the catalog has them. */
const MIN_DECORATED_IN_POOL = 4;

/** ...and how many plain ones, so the base role is never starved either. */
const MIN_BASE_IN_POOL = 4;

export function ensureRoleCoverage(selected: RankedTile[], ranked: RankedTile[]): RankedTile[] {
  const isDecorated = (t: RankedTile) => DECORATED_TYPES.has(t.type);
  const out = [...selected];

  for (const [wanted, matches] of [
    [MIN_DECORATED_IN_POOL, isDecorated] as const,
    [MIN_BASE_IN_POOL, (t: RankedTile) => !isDecorated(t)] as const,
  ]) {
    const have = out.filter(matches).length;
    if (have >= wanted) continue;

    const present = new Set(out.map((t) => t.id));
    const candidates = ranked.filter((t) => matches(t) && !present.has(t.id));
    const room = Math.min(wanted - have, candidates.length);

    // The weakest members of the OTHER kind make way -- never the kind we
    // are short of, and never so many that the other kind drops below its
    // own floor.
    const spare = Math.max(0, out.filter((t) => !matches(t)).length - Math.min(wanted, MIN_BASE_IN_POOL));
    const victims: number[] = [];
    for (let j = out.length - 1; j >= 0 && victims.length < Math.min(room, spare); j -= 1) {
      if (!matches(out[j])) victims.push(j);
    }

    // Filled in slate order with candidates already in merit order, so
    // the best of them reads first rather than last.
    victims.sort((a, b) => a - b);
    victims.forEach((at, i) => { out[at] = candidates[i]; });
  }

  return out;
}

function interleaveBySource(
  ranked: RankedTile[],
  sourceOf: (tileId: string) => string,
  limit: number,
): RankedTile[] {
  if (ranked.length <= limit) return ranked;

  const bySource = new Map<string, RankedTile[]>();
  for (const tile of ranked) {
    const key = sourceOf(tile.id);
    const group = bySource.get(key);
    if (group) group.push(tile);
    else bySource.set(key, [tile]);
  }

  const groups = [...bySource.values()];

  // WHY THE ORDER MATTERS, AND ONLY HERE.
  //
  // Every group contributes its best tile at depth 0, so with a handful
  // of catalogs each is represented whatever the order. Only once the
  // catalogs outnumber the pool limit does depth 0 alone fill it, and
  // the groups visited last are then cut entirely.
  //
  // So the order has to be the one that cuts the right catalogs. It is
  // merit: the score of each group's best tile. The catalogs dropped are
  // the ones with the weakest best candidate, which is a design answer.
  // It used to be recency -- newest catalog first -- which cut by age
  // rather than by fit, and in a crowded pool pushed older catalogs out
  // however well their stock suited the brief.
  groups.sort((a, b) => (b[0]?.score ?? 0) - (a[0]?.score ?? 0));

  const selected: RankedTile[] = [];

  for (let depth = 0; selected.length < limit; depth += 1) {
    let progressed = false;

    for (const group of groups) {
      if (depth >= group.length) continue;

      selected.push(group[depth]);
      progressed = true;

      if (selected.length >= limit) break;
    }

    if (!progressed) break;
  }

  return selected;
}

/**
 * Tile filtering + ranking, wired to the real database. Filtering
 * (in-stock, brand, type) is a hard SQL WHERE — a red tile that's out of
 * stock or the wrong brand should never appear, full stop. Room/style/
 * color are then applied as ranking, not filtering, per rankTiles' reasoning above.
 */
export async function getRecommendedTiles(prisma: PrismaTileClient, filter: RecommendationFilter): Promise<RankedTile[]> {
  const tiles = await prisma.tile.findMany({
    where: {
      inStock: true,
      // A tile is only selectable while it is still backed by a real
      // source: either a MASTER-sheet row (sheetRowRef, written solely by
      // masterTileSync.service.ts) or a Catalog that still exists.
      //
      // Without this, deleting a catalog in the UI has no effect on what
      // can be combined: deleteCatalog defaults to deleteTiles=false, and
      // Tile.catalogId is an optional relation (onDelete: SetNull), so its
      // tiles survive with catalogId=null and inStock=true and stay in
      // this pool forever.
      OR: [{ sheetRowRef: { not: null } }, { catalogId: { not: null } }],
      ...(filter.brandId ? { brandId: filter.brandId } : {}),
      ...(filter.type ? { type: filter.type } : {}),
    },
    include: { brand: { select: { name: true } } },
  });

  // Every row the filters above accept becomes a candidate -- including
  // several extractions of the SAME product, whose stored images can
  // legitimately differ. They are deliberately NOT collapsed to one
  // "current" copy here: each is a real, separately-stored tile, and which
  // of them (if any) belongs in a board is a judgement for the scoring
  // below, not for a recency rule applied before scoring ever runs.
  const forRanking: TileForRanking[] = tiles.map((t) => ({
    id: t.id,
    name: t.name,
    brandName: t.brand.name,
    size: t.size,
    finish: t.finish,
    type: t.type,
    colorTone: t.colorTone,
    bestRoom: t.bestRoom,
    productCode: t.productCode,
    // The row's own timestamps, which is what "latest extraction" is
    // decided from below -- not array order, not product code order.
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    imageBbox: t.imageBbox,
    imageUrl: normalizeDriveImageUrl(t.imageUrl),
  }));

  // Ranking decides the order, on room, theme and colour fit alone.
  // When a tile was extracted is not one of the signals: old and new
  // stock compete on the same terms.
  const ranked = rankTiles(forRanking, {
    room: filter.room,
    style: filter.style,
    colorTone: filter.colorTone,
    varietySeed: filter.varietySeed,
  });

  const sourceByTileId = new Map<string, string>(tiles.map((t) => [t.id, sourceGroupKey(t)]));
  const selected = ensureRoleCoverage(
    interleaveBySource(ranked, (id) => sourceByTileId.get(id) ?? `tile:${id}`, filter.limit ?? 20),
    ranked,
  );

  return selected.map((t) => ({
    ...t,
    catalogGroup: sourceByTileId.get(t.id) ?? `tile:${t.id}`,
    // How many rows the filters accepted, so the caller can say how much
    // of the catalog was in contention for the places it is about to
    // offer. Carried on the tiles rather than changing the return shape,
    // which every existing caller and test depends on.
    poolMatched: tiles.length,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// Plain browse — the Catalog page's "Surface Archive" needs every tile
// (in and out of stock, shown with an honest status badge each), not a
// style-ranked subset, so this is a straightforward paginated/searchable
// list rather than a call into rankTiles() above.
// ─────────────────────────────────────────────────────────────────────────

/**
 * The floor-module sizes this catalog actually holds.
 *
 * The wizard's Custom size dropdown is built from this and nothing
 * else: a size the stock does not come in is not a size the client can
 * be offered, however plausible it sounds. Counts ride along so the
 * caller can lead with the sizes the catalog is deepest in.
 *
 * Only in-stock, still-sourced tiles count -- the same two conditions
 * getRecommendedTiles applies, so the dropdown cannot offer a size that
 * no selectable tile comes in.
 */
export async function listCatalogTileSizes() {
  const rows = await prisma.tile.groupBy({
    by: ['size'],
    where: {
      inStock: true,
      size: { not: null },
      OR: [{ sheetRowRef: { not: null } }, { catalogId: { not: null } }],
    },
    _count: { size: true },
  });

  return rows
    .map((row) => ({ size: (row.size ?? '').trim(), tiles: row._count.size }))
    .filter((row) => row.size.length > 0)
    .sort((a, b) => b.tiles - a.tiles || a.size.localeCompare(b.size));
}

export async function listAllTiles(query: ListTilesQuery) {
  const { page, limit, skip, take } = getPagination(query);
  const where = {
    ...(query.search ? { name: { contains: query.search, mode: 'insensitive' as const } } : {}),
    ...(query.collection ? { collection: query.collection } : {}),
    ...(query.brandId ? { brandId: query.brandId } : {}),
  };

  const [tiles, total] = await Promise.all([
    prisma.tile.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        imageUrl: true,
        size: true,
        finish: true,
        colorTone: true,
        collection: true,
        inStock: true,
        productCode: true,
        brand: { select: { id: true, name: true } },
      },
    }),
    prisma.tile.count({ where }),
  ]);

  return {
    tiles: tiles.map((t) => ({ ...t, imageUrl: normalizeDriveImageUrl(t.imageUrl) })),
    meta: buildPaginationMeta(total, page, limit) as PaginationMeta,
  };
}

// Minimal structural type for the Prisma client's tile delegate — keeps
// this module from depending on the full generated PrismaClient type,
// which makes it easier to unit test rankTiles()/scoring in isolation.
// Both args and the return shape are intentionally untyped (any): Prisma's
// real findMany signature is generic, with a return type that depends on
// exactly what's passed as include/select at each call site — a fixed,
// non-generic interface can never structurally match that, no matter how
// the return shape here is written. The real field shape actually relied
// on is enforced where it's used instead (getRecommendedTiles's .map()
// below), not at this boundary.
export interface PrismaTileClient {
  tile: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<any[]>;
  };
}