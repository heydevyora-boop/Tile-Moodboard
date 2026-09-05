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
    include: { brand: { select: { name: true } } },
  });

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
  }));

  const ranked = rankTiles(forRanking, { room: filter.room, style: filter.style, colorTone: filter.colorTone });

  const sourceByTileId = new Map<string, string>(tiles.map((t) => [t.id, sourceGroupKey(t)]));
  return interleaveBySource(ranked, (id) => sourceByTileId.get(id) ?? `tile:${id}`, filter.limit ?? 20);
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