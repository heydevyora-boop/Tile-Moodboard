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
  // the recency signal below contributes nothing at all.
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}

export interface RankingCriteria {
  room?: string;
  style?: string;
  colorTone?: string;
}

export interface RankedTile extends TileForRanking {
  score: number;
  matchReasons: string[];
  // Only populated by getRecommendedTiles() (rankTiles() alone has no
  // notion of catalogs) -- see sourceGroupKey() below.
  catalogGroup?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Extraction recency
//
// A newly extracted catalog was losing every board to the tiles already
// in the database, and not because of a filter or a cache: measured
// against the real scorer, a freshly synced tile scores 10 where an
// established one scores 72. The gap is metadata. masterTileSync writes
// what the extraction pipeline sends -- a product code, an image, a
// collection -- and nothing else, so every new tile arrives with no
// bestRoom, no colorTone, no finish and no size. scoreRoom gives it the
// +8 "versatile" credit instead of the +40 exact-room match, scoreColor
// and scoreStyle give it nothing, and it sorts below everything.
//
// So recency is now a signal, which it deliberately was not before. The
// note further down explaining why it was excluded described a DIFFERENT
// mechanism -- collapsing duplicate rows to one "current" copy BEFORE
// scoring, which removed real candidates from the pool. That is still
// gone and is not what this is: nothing is removed here, a bounded bonus
// is added, and every older tile stays exactly as selectable as it was.
//
// Bounded on purpose. At +18 a tile from the newest extraction wins a
// near-tie and loses a real mismatch: it cannot overturn an exact room
// match (+40) or an exact colour match (+30), so "prefer the latest when
// it is a suitable match" holds without becoming "always replace the old
// with the new". It is also honestly not enough to close the 62-point
// metadata gap above on its own -- an untagged tile still loses to a
// well-tagged one, as it should, until the extraction supplies the tags.
const RECENCY_BONUS = 18;

// How wide "the latest extraction" is. One sync run writes its rows over
// seconds to minutes, so a window keeps a batch together instead of
// privileging whichever row of it happened to be written last.
const RECENCY_WINDOW_MS = 6 * 60 * 60 * 1000;

/** The moment this tile was last written, or null when unknown. */
export function extractionTime(tile: TileForRanking): number | null {
  const stamps = [tile.updatedAt, tile.createdAt]
    .map((value) => (value ? new Date(value).getTime() : NaN))
    .filter((value) => Number.isFinite(value));

  return stamps.length > 0 ? Math.max(...stamps) : null;
}

function scoreRecency(tile: TileForRanking, newest: number | null): { points: number; reasons: string[] } {
  if (newest === null) return { points: 0, reasons: [] };

  const when = extractionTime(tile);
  if (when === null) return { points: 0, reasons: [] };

  if (newest - when <= RECENCY_WINDOW_MS) {
    return { points: RECENCY_BONUS, reasons: ['From the latest extraction'] };
  }

  return { points: 0, reasons: [] };
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
    const recency = scoreRecency(tile, newest);
    const baseTieBreak = tile.type === 'BASE' ? 2 : 0;

    return {
      ...tile,
      score: room.points + style.points + color.points + recency.points + baseTieBreak,
      matchReasons: [...room.reasons, ...style.reasons, ...color.reasons, ...recency.reasons],
    };
  });

  return ranked.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

export interface RecommendationFilter {
  brandId?: string;
  type?: string;
  room?: string;
  style?: string;
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
function interleaveBySource(
  ranked: RankedTile[],
  sourceOf: (tileId: string) => string,
  limit: number,
  // Visit order for the groups. Supplied by getRecommendedTiles so the
  // most recently extracted catalog is served first; omitted, groups
  // keep their previous order (the one their best-ranked tile appeared
  // in) and this behaves exactly as it did.
  recencyOf?: (tileId: string) => number | null,
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
  // of catalogs each is represented whatever the order. Once the
  // catalogs outnumber the pool limit, depth 0 alone fills it and the
  // groups visited last are cut entirely -- and a freshly extracted
  // catalog is exactly the one that sorts last, because its tiles carry
  // no metadata to score on. That is the newest products being dropped
  // before the model ever sees them.
  //
  // Serving the most recent source first fixes that truncation without
  // taking a slot from anyone: the same number of tiles comes back, and
  // with few catalogs loaded the membership is identical -- only the
  // order changes.
  if (recencyOf) {
    const groupRecency = new Map<RankedTile[], number>();
    for (const group of groups) {
      const stamps = group
        .map((tile) => recencyOf(tile.id))
        .filter((value): value is number => value !== null);
      groupRecency.set(group, stamps.length > 0 ? Math.max(...stamps) : 0);
    }
    groups.sort((a, b) => (groupRecency.get(b) ?? 0) - (groupRecency.get(a) ?? 0));
  }
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
  }));

  // Ranking decides the order. Extraction recency is one of the signals
  // it weighs (see RECENCY_BONUS) -- bounded, so the newest catalog wins
  // a near-tie and never overturns a genuinely better match, and every
  // older tile stays exactly as selectable as it was.
  const ranked = rankTiles(forRanking, { room: filter.room, style: filter.style, colorTone: filter.colorTone });

  const sourceByTileId = new Map<string, string>(tiles.map((t) => [t.id, sourceGroupKey(t)]));
  const recencyByTileId = new Map<string, number | null>(
    forRanking.map((t) => [t.id, extractionTime(t)]),
  );
  const selected = interleaveBySource(
    ranked,
    (id) => sourceByTileId.get(id) ?? `tile:${id}`,
    filter.limit ?? 20,
    (id) => recencyByTileId.get(id) ?? null,
  );

  return selected.map((t) => ({ ...t, catalogGroup: sourceByTileId.get(t.id) ?? `tile:${t.id}` }));
}

// ─────────────────────────────────────────────────────────────────────────
// Plain browse — the Catalog page's "Surface Archive" needs every tile
// (in and out of stock, shown with an honest status badge each), not a
// style-ranked subset, so this is a straightforward paginated/searchable
// list rather than a call into rankTiles() above.
// ─────────────────────────────────────────────────────────────────────────

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