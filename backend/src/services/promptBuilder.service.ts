import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';
import { geminiClient } from './gemini.service';
import { getRecommendedTiles } from './tileRecommendation.service';
import { GenerateBriefInput } from '@validators/moodBoard.validators';
import { getSettings } from './settings.service';

// ─────────────────────────────────────────────────────────────────────────
// 1. Read Design Rules
// ─────────────────────────────────────────────────────────────────────────

/**
 * Reads the currently PUBLISHED design rules (Module 9/10's `RuleVersion`)
 * — not the draft. Whatever the owner most recently published is what the
 * AI should follow; unpublished draft edits shouldn't silently change
 * live mood board generation.
 */
export async function getLiveDesignRulesText(): Promise<string> {
  const latest = await prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
  if (!latest) {
    throw AppError.badRequest('No design rules have been published yet. Publish rules in Design Rules before generating mood boards.');
  }
  return latest.fullContent;
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Read Tile Database
// ─────────────────────────────────────────────────────────────────────────

export interface TileSummary {
  id: string;
  name: string;
  brandName: string;
  size: string | null;
  finish: string | null;
  type: string;
  colorTone: string | null;
  bestRoom: string | null;
  productCode: string | null;
  catalogGroup: string;
  // Whether this tile came from the newest extraction in the pool.
  // rankTiles decides it; the prompt below says it out loud.
  fromLatestExtraction: boolean;
}

const MAX_TILES_IN_PROMPT = 80;

/**
 * Pulls the pool of real, in-stock tiles the AI is allowed to choose
 * from. This is what keeps generated combinations grounded in actual
 * store inventory instead of the model inventing plausible-sounding
 * products that don't exist — the prompt later instructs it to reference
 * these by id only, and the response is validated against this exact set.
 *
 * Brand is a hard filter (asking for a specific brand should never
 * surface a different one), but room and style are handled by Module
 * 15's ranking engine rather than a hard filter — a store with only
 * "Bathroom"-tagged tiles in stock should still be able to generate a
 * living-room board using versatile/close tiles, ranked appropriately,
 * rather than failing outright because no tile has an exact room tag.
 */
export async function getAvailableTiles(filter: { brandId?: string; room?: string; style?: string }): Promise<TileSummary[]> {
  const ranked = await getRecommendedTiles(prisma, {
    brandId: filter.brandId,
    room: filter.room,
    style: filter.style,
    limit: MAX_TILES_IN_PROMPT,
  });

  return ranked.map((t) => ({
    id: t.id,
    name: t.name,
    brandName: t.brandName ?? '',
    size: t.size ?? null,
    finish: t.finish ?? null,
    type: t.type,
    colorTone: t.colorTone ?? null,
    bestRoom: t.bestRoom ?? null,
    productCode: t.productCode ?? null,
    catalogGroup: t.catalogGroup ?? `tile:${t.id}`,
    fromLatestExtraction: t.fromLatestExtraction === true,
  }));
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Read Customer Brief
// ─────────────────────────────────────────────────────────────────────────

export interface ClientBriefContext {
  text: string;
  style?: string;
  room?: string;
  budget?: string;
  customerName?: string;
}

/**
 * Resolves the full brief context — the staff-entered text plus any
 * structured hints, enriched with a linked Customer's stored preferences
 * when the staff didn't override them explicitly. An explicit field on
 * the request always wins over what's on file for the customer.
 */
export async function resolveBriefContext(input: GenerateBriefInput, defaults?: { defaultRoomType?: string; defaultStyleTag?: string }): Promise<ClientBriefContext> {
  let customerName: string | undefined;
  let style = input.style;
  let room = input.room;
  let budget = input.budget;

  if (input.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw AppError.notFound('Customer not found');
    customerName = customer.name;
    style = style ?? customer.preferredStyle ?? undefined;
    room = room ?? customer.preferredRoom ?? undefined;
    budget = budget ?? customer.budget ?? undefined;
  }

  // Org-configured fallback (Application Settings > Default Rules) — lowest
  // priority, only applies when neither the brief nor the customer record said anything.
  style = style ?? (defaults?.defaultStyleTag ? defaults.defaultStyleTag.toUpperCase() : undefined);
  room = room ?? (defaults?.defaultRoomType ? defaults.defaultRoomType.toUpperCase() : undefined);

  return { text: input.text, style, room, budget, customerName };
}

// ─────────────────────────────────────────────────────────────────────────
// 4. Build AI Prompt (pure — no I/O, fully unit-testable on its own)
// ─────────────────────────────────────────────────────────────────────────

export interface BuiltPrompt {
  systemInstruction: string;
  userPrompt: string;
}

function formatTileForPrompt(t: TileSummary): string {
  const bits = [
    `id="${t.id}"`,
    `name="${t.name}"`,
    `brand="${t.brandName}"`,
    t.type ? `type=${t.type}` : null,
    t.size ? `size=${t.size}` : null,
    t.finish ? `finish=${t.finish}` : null,
    t.colorTone ? `color=${t.colorTone}` : null,
    t.bestRoom ? `room=${t.bestRoom}` : null,
    t.productCode ? `code=${t.productCode}` : null,
    // Why this marker exists.
    //
    // A tile synced straight from an extraction carries a product code, a
    // size, an image and nothing else: backend_sync.py sends no finish, no
    // colour and no room, because main_step6_complete has not classified
    // the product at that stage. So a freshly extracted product reaches
    // this list with its colour and finish simply absent -- while the
    // brief above asks for a palette and a finish by name. The model does
    // the reasonable thing with that and picks the products it can match,
    // which are always the older, fully described ones. The catalog owner
    // sees a board built entirely from the same two old series however
    // much new stock was just extracted.
    //
    // Marking them is what lets the rules below say "judge these on name,
    // brand and size, and do not pass over them for fields nobody has
    // filled in yet".
    t.fromLatestExtraction ? 'batch=LATEST' : null,
  ].filter(Boolean);
  return `- ${bits.join(', ')}`;
}

const JSON_SCHEMA_INSTRUCTIONS = `
Return ONLY a JSON array (no markdown, no commentary, no code fences) of mood board combinations. Each element must have exactly this shape:

{
  "board_name": string,
  "tiles": [ { "role": "base" | "highlight" | "border" | "accent", "tileId": string, "name": string } ],
  "grout_recommendation": string,
  "rooms_suitable": string[],
  "reason_for_selection": string
}

Rules for the "tiles" array:
- "tileId" MUST be copied exactly from the "id" field of one of the tiles listed below. Never invent a tileId, and never use a tile that is not in the list.
- Every combination needs exactly one "base" tile, plus at least one of "highlight", "border", or "accent" — follow the design rules above for exactly which roles to combine.
- Each role in a combination must use a DIFFERENT tile. Never give the same tileId two roles — a board whose base and highlight are the same product is not a combination.
- "name" should match the tile's listed name, for readability.

Rules about the budget:
- The budget line above is a TOTAL for floor and wall tiles in the stated room, not a rate per tile. It already states the area it has to cover.
- None of the products listed below carries a price. So do not state, estimate or imply a cost, a total or a saving — you have no basis for one, and an invented figure is worse than none. Judge the budget by what the band plainly signals: a lower band means plain, bulk-stocked bodies and few decorated pieces; a higher band allows a decorated highlight and a more worked surface.
- Say in "reason_for_selection" how the combination sits against the band in those terms, and say plainly when the listed stock gives you nothing that suits it rather than offering something that does not.
- When the budget line names more than one band, return one combination per band, in the order they are named, and say which band each one answers.

Rules about which tile may take which role:
- "base" is the plain field of the room. It must be a tile listed as type=BASE or type=LARGE_FORMAT_BASE — a quiet surface, plain or softly veined.
- "highlight", "accent" and "border" are the decorated roles. A highlight is a DESIGNER tile: it must be a tile listed as type=HIGHLIGHTER, type=ACCENT or type=BORDER. Never nominate a plain type=BASE tile as the highlight, and never put a decorated tile in the base role — a board whose highlight is plainer than its base is the wrong way round.
- If no decorated tile is listed at all, return the base alone and say so in reason_for_selection. Do not promote a base tile into a decorated role to fill the shape.

Rules about the tile list itself:
- A tile marked batch=LATEST came from the most recent catalog extraction. Those products have not been classified yet, which is why their finish, colour and room are missing from the list — that means "not recorded", never "unsuitable". Judge them on their name, brand, size and type, exactly as seriously as the older products whose attributes are filled in.
- At least one of the combinations you return must use a batch=LATEST product, whenever any appear in the list. Do not return a set of combinations built entirely from the older products while new stock is sitting in the list unused.
- Across all the combinations together, do not keep reusing one product series. Two boards whose base tiles differ only by a trailing index are the same board twice.
`.trim();

/**
 * Builds the exact system instruction + user prompt sent to Gemini. Pure
 * function — same inputs always produce the same prompt, which is what
 * makes this testable without a database or network call.
 */
export function buildPrompt(
  designRulesText: string,
  tiles: TileSummary[],
  brief: ClientBriefContext,
  combinationCount: number,
): BuiltPrompt {
  const systemInstruction = [
    'You are the in-house design assistant for Casa de Aurum, a tile and stone retailer.',
    "You recommend tile combinations for customers based on the store owner's design rules below.",
    'Follow these rules exactly — they encode the owner\'s taste and years of retail experience.',
    '',
    designRulesText,
  ].join('\n');

  const briefLines = [
    `Client brief: ${brief.text}`,
    brief.customerName ? `Customer: ${brief.customerName}` : null,
    brief.style ? `Requested style: ${brief.style}` : null,
    brief.room ? `Room: ${brief.room}` : null,
    brief.budget ? `Budget: ${brief.budget}` : null,
  ].filter((line): line is string => line !== null);

  const tileList = tiles.length > 0 ? tiles.map(formatTileForPrompt).join('\n') : '(no tiles currently in stock match this brief)';

  const userPrompt = [
    briefLines.join('\n'),
    '',
    `Generate exactly ${combinationCount} distinct tile combinations for this brief, chosen only from the tiles below:`,
    '',
    tileList,
    '',
    JSON_SCHEMA_INSTRUCTIONS,
  ].join('\n');

  return { systemInstruction, userPrompt };
}

// ─────────────────────────────────────────────────────────────────────────
// 5. Return Structured JSON — call Gemini, validate the response
// ─────────────────────────────────────────────────────────────────────────

export interface GeneratedTileRef {
  role: 'base' | 'highlight' | 'border' | 'accent';
  tileId: string;
  name: string;
}

export interface GeneratedCombination {
  board_name: string;
  tiles: GeneratedTileRef[];
  grout_recommendation: string;
  rooms_suitable: string[];
  reason_for_selection: string;
}

const VALID_ROLES = new Set(['base', 'highlight', 'border', 'accent']);

/**
 * Validates Gemini's raw JSON response against the shape we asked for
 * and — critically — drops any tile reference that doesn't correspond to
 * a tile we actually sent it. An LLM confidently referencing a
 * non-existent tileId is exactly the failure mode this guards against;
 * silently trusting the response would let a hallucinated product reach
 * a customer-facing mood board.
 */
// Which Tile.type values may carry which role.
//
// The catalog owner's complaint, exactly: a board came back with a plain
// tile nominated as the highlight and the decorated one sitting in the
// base slot. The prompt now says not to, but a prompt is a request --
// the pool already records what each product IS, so the swap is provable
// here rather than hoped against.
const DECORATED_ROLES = new Set(['highlight', 'accent', 'border']);
const DECORATED_TYPES = new Set(['HIGHLIGHTER', 'ACCENT', 'BORDER']);
const BASE_TYPES = new Set(['BASE', 'LARGE_FORMAT_BASE']);

export function validateCombinations(
  raw: unknown,
  consideredTileIds: Set<string>,
  // Optional so every existing caller and test keeps working; when it is
  // supplied the role check below runs, and when it is not the behaviour
  // is exactly what it was.
  typeByTileId?: Map<string, string>,
): { combinations: GeneratedCombination[]; warnings: string[] } {
  // Only worth enforcing when the pool actually offered an alternative.
  // A catalog with nothing decorated in it must still produce a board,
  // so the rule holds the model to what was available, not to an ideal.
  const poolHasDecorated = typeByTileId
    ? [...typeByTileId.values()].some((type) => DECORATED_TYPES.has(type))
    : false;
  const warnings: string[] = [];

  if (!Array.isArray(raw)) {
    throw AppError.internal('Gemini response was not a JSON array as instructed');
  }

  const combinations: GeneratedCombination[] = [];

  raw.forEach((item, index) => {
    if (typeof item !== 'object' || item === null) {
      warnings.push(`Combination ${index}: not an object, skipped`);
      return;
    }
    const obj = item as Record<string, unknown>;

    if (typeof obj.board_name !== 'string' || !Array.isArray(obj.tiles)) {
      warnings.push(`Combination ${index}: missing board_name or tiles array, skipped`);
      return;
    }

    const validTiles: GeneratedTileRef[] = [];
    // One product cannot be two roles at once. Validation checked that
    // every tileId was real and every role was spelled correctly, and
    // never that the ids differed — so "base: X, highlight: X" passed
    // silently, and the board that came out had the same tile twice.
    // The first role wins; a repeat is dropped and said out loud.
    const usedTileIds = new Set<string>();
    for (const tileRaw of obj.tiles) {
      if (typeof tileRaw !== 'object' || tileRaw === null) continue;
      const t = tileRaw as Record<string, unknown>;
      const role = typeof t.role === 'string' ? t.role.trim().toLowerCase() : '';
      const tileId = typeof t.tileId === 'string' ? t.tileId : '';

      if (!VALID_ROLES.has(role)) {
        warnings.push(`Combination ${index}: dropped a tile with invalid role "${role}"`);
        continue;
      }
      if (!consideredTileIds.has(tileId)) {
        warnings.push(`Combination ${index}: dropped tileId "${tileId}" — not in the tile list we provided (likely hallucinated)`);
        continue;
      }
      if (usedTileIds.has(tileId)) {
        warnings.push(`Combination ${index}: dropped the "${role}" role — tileId "${tileId}" is already used by another role in this combination`);
        continue;
      }
      const tileType = typeByTileId?.get(tileId);
      if (tileType && poolHasDecorated && DECORATED_ROLES.has(role) && BASE_TYPES.has(tileType)) {
        warnings.push(`Combination ${index}: dropped the "${role}" role — tileId "${tileId}" is a plain ${tileType} tile, and a decorated product was available. A highlight has to be a designer tile.`);
        continue;
      }
      if (tileType && role === 'base' && DECORATED_TYPES.has(tileType)) {
        warnings.push(`Combination ${index}: dropped the "base" role — tileId "${tileId}" is a decorated ${tileType} tile, which belongs in the highlight, not under it.`);
        continue;
      }
      usedTileIds.add(tileId);
      validTiles.push({ role: role as GeneratedTileRef['role'], tileId, name: typeof t.name === 'string' ? t.name : '' });
    }

    if (validTiles.length === 0) {
      warnings.push(`Combination ${index} ("${obj.board_name}"): no valid tiles remained after validation, skipped entirely`);
      return;
    }
    if (!validTiles.some((t) => t.role === 'base')) {
      warnings.push(`Combination ${index} ("${obj.board_name}"): no base tile — kept anyway, but flag for review`);
    }

    combinations.push({
      board_name: obj.board_name,
      tiles: validTiles,
      grout_recommendation: typeof obj.grout_recommendation === 'string' ? obj.grout_recommendation : '',
      rooms_suitable: Array.isArray(obj.rooms_suitable) ? obj.rooms_suitable.filter((r): r is string => typeof r === 'string') : [],
      reason_for_selection: typeof obj.reason_for_selection === 'string' ? obj.reason_for_selection : '',
    });
  });

  return { combinations, warnings };
}

export interface GenerateResult {
  prompt: BuiltPrompt;
  combinations: GeneratedCombination[];
  warnings: string[];
  tilesConsidered: number;
}

/** Orchestrates all five steps: read rules, read tiles, read brief, build prompt, call Gemini, validate. */
export async function generateCombinations(input: GenerateBriefInput, actorId: string, req?: Request): Promise<GenerateResult> {
  const rulesSettings = await getSettings('rules');
  const [designRulesText, brief] = await Promise.all([
    getLiveDesignRulesText(),
    resolveBriefContext(input, { defaultRoomType: rulesSettings.defaultRoomType, defaultStyleTag: rulesSettings.defaultStyleTag }),
  ]);
  const combinationCount = input.combinationCount ?? rulesSettings.defaultMaxCombinations;

  const tiles = await getAvailableTiles({ brandId: input.brandId, room: brief.room, style: brief.style });
  if (tiles.length === 0) {
    throw AppError.badRequest('No in-stock tiles are available for this request — check that this brand has tiles in stock, or add tiles to the catalog first.');
  }

  const prompt = buildPrompt(designRulesText, tiles, brief, combinationCount);

  const raw = await geminiClient.generateJSON<unknown>(prompt.userPrompt, { systemInstruction: prompt.systemInstruction });

  const consideredIds = new Set(tiles.map((t) => t.id));
  const typeByTileId = new Map(tiles.map((t) => [t.id, t.type]));
  const { combinations, warnings } = validateCombinations(raw, consideredIds, typeByTileId);

  if (tiles.length < rulesSettings.defaultMinTiles) {
    warnings.push(`Only ${tiles.length} tile(s) matched this brief — fewer than the configured minimum of ${rulesSettings.defaultMinTiles} (Settings > Default Rules).`);
  }

  // Best-effort catalog diversity check: the prompt pool itself is already
  // interleaved across catalogs (getRecommendedTiles), but Gemini's own
  // picks across the returned boards could still land on just one or two
  // of them. This doesn't reshuffle Gemini's picks -- it only flags it,
  // the same way the tile-count check above does, so a store with
  // genuinely few matching catalogs for this brief isn't blocked outright.
  const catalogGroupByTileId = new Map(tiles.map((t) => [t.id, t.catalogGroup]));
  const usedCatalogGroups = new Set<string>();
  for (const combo of combinations) {
    for (const tileRef of combo.tiles) {
      const group = catalogGroupByTileId.get(tileRef.tileId);
      if (group) usedCatalogGroups.add(group);
    }
  }
  if (usedCatalogGroups.size < rulesSettings.defaultMinCatalogs) {
    warnings.push(`Only ${usedCatalogGroups.size} distinct catalog(s) represented across the generated boards — fewer than the configured minimum of ${rulesSettings.defaultMinCatalogs} (Settings > Default Rules).`);
  }

  await logActivity({
    userId: actorId,
    action: 'mood_board.prompt_generated',
    entityType: 'MoodBoard',
    metadata: { briefText: input.text, tilesConsidered: tiles.length, combinationsReturned: combinations.length, warnings },
    req,
  });

  return { prompt, combinations, warnings, tilesConsidered: tiles.length };
}
