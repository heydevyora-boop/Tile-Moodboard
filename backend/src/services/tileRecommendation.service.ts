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
  const ranked = tiles.map((tile) => {
    const room = scoreRoom(tile, criteria.room);
    const style = scoreStyle(tile, criteria.style);
    const color = scoreColor(tile, criteria.colorTone);
    const baseTieBreak = tile.type === 'BASE' ? 2 : 0;

    return {
      ...tile,
      score: room.points + style.points + color.points + baseTieBreak,
      matchReasons: [...room.reasons, ...style.reasons, ...color.reasons],
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
// Extraction recency — which copy of a product is the current one
//
// Re-running the catalog extractor over a brand's PDF inserts a NEW Tile
// row per product rather than updating the previous run's row, so the same
// physical product legitimately exists several times over: once per
// extraction it has ever appeared in. Nothing below the database
// distinguished those copies, so which one reached a mood board came down
// to rankTiles' alphabetical tie-break (`a.name.localeCompare(b.name)`) --
// and for two rows of the SAME product the names are identical, making the
// winner effectively arbitrary. In practice that meant a re-extracted
// product kept being represented by whichever older row happened to sort
// first, image and all, even though a newer, better extraction of that
// exact product was sitting right next to it.
//
// Recency is read from metadata that already exists (Catalog.completedAt /
// Catalog.createdAt, else Tile.createdAt) -- no new schema, no migration.
// ─────────────────────────────────────────────────────────────────────────

interface TileRecencySource {
  createdAt?: Date | string | null;
  catalog?: { completedAt?: Date | string | null; createdAt?: Date | string | null } | null;
}

/**
 * When this tile's extraction run finished, as a timestamp.
 *
 * The Catalog's own completion time is the real "which extraction is this"
 * signal, so it leads. Tiles synced from the MASTER sheet have no Catalog
 * row at all (masterTileSync.service.ts leaves catalogId null), which is
 * why the tile's own createdAt is the fallback rather than an error.
 */
function extractionRecency(tile: TileRecencySource): number {
  const candidate = tile.catalog?.completedAt ?? tile.catalog?.createdAt ?? tile.createdAt;
  if (!candidate) return 0;
  const time = new Date(candidate).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Identity of the PRODUCT, as distinct from the identity of a row.
 *
 * productCode is the real SKU and is what makes two rows the same product
 * across extractions. Falling back to name+size rather than to the row id
 * is deliberate: an id fallback would make every row its own product and
 * silently disable the de-duplication below for exactly the catalogs whose
 * codes the extractor could not read.
 */
function productIdentityKey(tile: { productCode?: string | null; name: string; size?: string | null }): string {
  const code = tile.productCode?.trim().toUpperCase();
  if (code) return `code:${code}`;
  return `name:${tile.name.trim().toLowerCase()}|${(tile.size ?? '').trim().toLowerCase()}`;
}

function hasUsableImage(tile: { imageUrl?: string | null }): boolean {
  return typeof tile.imageUrl === 'string' && tile.imageUrl.trim().length > 0;
}

/**
 * Collapses multiple extractions of the same product down to the copy that
 * should represent it, newest-first:
 *
 *   1. the most recent extraction that actually has an image
 *   2. otherwise the most recent copy at all (no image anywhere -- the
 *      product still competes on its metadata, exactly as it did before)
 *
 * Step 1 is what keeps an older copy from winning purely by existing
 * first, while step 2 is what stops a newer image-less copy from hiding an
 * older one that does have an image. Only the losing DUPLICATES are
 * dropped; a product that appears once is returned untouched, so a catalog
 * of entirely distinct products passes through this unchanged.
 */
function keepCurrentExtractionPerProduct<T extends TileRecencySource & { productCode?: string | null; name: string; size?: string | null; imageUrl?: string | null }>(
  tiles: T[],
): T[] {
  const byProduct = new Map<string, T>();

  for (const tile of tiles) {
    const key = productIdentityKey(tile);
    const incumbent = byProduct.get(key);

    if (!incumbent) {
      byProduct.set(key, tile);
      continue;
    }

    const tileHasImage = hasUsableImage(tile);
    const incumbentHasImage = hasUsableImage(incumbent);

    // An image-bearing copy always beats an image-less one, whichever is
    // newer; recency only decides between two copies of equal usefulness.
    if (tileHasImage !== incumbentHasImage) {
      if (tileHasImage) byProduct.set(key, tile);
      continue;
    }

    if (extractionRecency(tile) > extractionRecency(incumbent)) {
      byProduct.set(key, tile);
    }
  }

  return [...byProduct.values()];
}

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
function interleaveBySource(ranked: RankedTile[], sourceOf: (tileId: string) => string, limit: number): RankedTile[] {
  if (ranked.length <= limit) return ranked;

  const bySource = new Map<string, RankedTile[]>();
  for (const tile of ranked) {
    const key = sourceOf(tile.id);
    const group = bySource.get(key);
    if (group) group.push(tile);
    else bySource.set(key, [tile]);
  }

  const groups = [...bySource.values()];
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
    include: {
      brand: { select: { name: true } },
      // Sourced purely to date this tile's extraction run -- see
      // extractionRecency(). Nothing here alters what is selectable.
      catalog: { select: { completedAt: true, createdAt: true } },
    },
  });

  // Collapse repeat extractions of the same product to the current copy
  // BEFORE ranking, so a product competes once, represented by its newest
  // usable extraction, rather than having several copies of itself
  // competing and an arbitrary one winning on the alphabetical tie-break.
  const currentTiles = keepCurrentExtractionPerProduct(tiles);

  const forRanking: TileForRanking[] = currentTiles.map((t) => ({
    id: t.id,
    name: t.name,
    brandName: t.brand.name,
    size: t.size,
    finish: t.finish,
    type: t.type,
    colorTone: t.colorTone,
    bestRoom: t.bestRoom,
    productCode: t.productCode,
  }));

  const ranked = rankTiles(forRanking, { room: filter.room, style: filter.style, colorTone: filter.colorTone });

  // Re-break ties by extraction recency, newest first.
  //
  // Scores are compared first and are NOT touched, so every room/style/
  // colour/role judgement rankTiles made survives exactly -- this only
  // decides the order of tiles rankTiles already considered equally good,
  // which it settles alphabetically because it has no notion of catalogs
  // (see the note on RankedTile.catalogGroup). Alphabetical order is
  // arbitrary with respect to which extraction a tile came from, so
  // without this a newly extracted product still loses its slot in the
  // pool to an equally-scored older one whose name sorts earlier. Kept
  // here rather than inside rankTiles so that function stays pure and
  // catalog-agnostic.
  const recencyByTileId = new Map<string, number>(tiles.map((t) => [t.id, extractionRecency(t)]));
  const recencyOf = (id: string) => recencyByTileId.get(id) ?? 0;
  const rankedByRecency = [...ranked].sort(
    (a, b) => b.score - a.score || recencyOf(b.id) - recencyOf(a.id) || a.name.localeCompare(b.name),
  );

  const sourceByTileId = new Map<string, string>(tiles.map((t) => [t.id, sourceGroupKey(t)]));
  const selected = interleaveBySource(rankedByRecency, (id) => sourceByTileId.get(id) ?? `tile:${id}`, filter.limit ?? 20);

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