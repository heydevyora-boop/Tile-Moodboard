import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';
import { geminiClient } from './gemini.service';
import { getRecommendedTiles } from './tileRecommendation.service';
import { screenSlate, lookalikeRoles } from './tileImageScreen.service';
import { themeBrief } from './themes.service';
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
  // Never written into the prompt -- the model cannot see pictures. It is
  // here so two products showing ONE surface can be told apart from two
  // products showing two; see lookalikeRoles below. Optional, so a
  // caller that has no pictures to offer still type-checks and simply
  // gets no surface comparison.
  imageUrl?: string | null;
  /**
   * How many catalog rows matched this brief before the pool limit cut
   * them, carried on the first tile only. Reported to the showroom so
   * "it only ever uses the same few products" is answerable with a
   * number instead of a guess.
   */
  poolMatched?: number;
  /**
   * How many of those the image screen could not fetch, and therefore
   * could not judge. Also first tile only. A split capture gets through
   * exactly when this is not zero, so it must never be silent again.
   */
  poolUnread?: number;
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
export async function getAvailableTiles(
  filter: { brandId?: string; room?: string; style?: string; varietySeed?: number },
): Promise<TileSummary[]> {
  const ranked = await getRecommendedTiles(prisma, {
    brandId: filter.brandId,
    room: filter.room,
    style: filter.style,
    limit: MAX_TILES_IN_PROMPT,
    varietySeed: filter.varietySeed,
  });

  // A capture holding two materials -- a tile with its neighbour caught
  // in the corner -- is a real row with a real picture, so nothing here
  // had any reason to pass it over, and boards came back built from
  // them. They are taken out of the slate before the model sees it.
  // screenSlate refuses to empty the slate, so a catalog whose every
  // capture is odd still produces a board.
  const { kept, unread } = await screenSlate(ranked);

  // Carried out on the first tile so generateCombinations can report
  // them without changing this function's return shape.
  const matched = ranked[0]?.poolMatched;

  return kept.map((t, index) => ({
    ...(index === 0 && matched !== undefined ? { poolMatched: matched } : {}),
    ...(index === 0 && unread.length > 0 ? { poolUnread: unread.length } : {}),
    id: t.id,
    name: t.name,
    brandName: t.brandName ?? '',
    size: t.size ?? null,
    finish: t.finish ?? null,
    type: t.type,
    colorTone: t.colorTone ?? null,
    bestRoom: t.bestRoom ?? null,
    imageUrl: t.imageUrl ?? null,
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
- Never claim a combination is within budget, fits the budget, comes in under it or is good value. Without a price per product you cannot know that, and a client reads such a claim as a quote. Describe what the band buys; do not certify the sum.
- Say in "reason_for_selection" how the combination sits against the band in those terms, and say plainly when the listed stock gives you nothing that suits it rather than offering something that does not.
- When the budget line names more than one band, return one combination per band, in the order they are named, and say which band each one answers.

Rules about the theme:
- The brief names a design theme and, above the tile list, states what that theme asks for. That statement is the specification: read it before choosing anything. Read it as a design language, not as a colour filter — British, Roman Touch, Floral, Tropical, Geometrical, Metallic, Rustic, Moroccan and Black & White each carry their own surfaces, patterns and contrast, and the floor, the wall and the decorated piece all have to belong to the same one.
- Every role has to answer the theme, not just the decorated one. A Moroccan board whose base could sit in a Metallic board is not a Moroccan board. Where the listed stock allows it, pick the base for the theme's ground colour and the highlight or accent for its pattern and its contrast.
- Choose on the theme's visual characteristics, using whatever each listed product gives you — its name and collection as much as its recorded finish, colour and size. A product whose attributes are blank can still be read from its name.
- Say in "reason_for_selection" what makes the combination read as that theme, naming the pieces. If the listed stock cannot carry the theme, say that plainly instead of assembling something that does not.
- When the brief says the theme is not specified, choose the theme yourself from the room, the budget and what is actually listed, and name the theme you chose in "board_name" or the first sentence of "reason_for_selection". Do not leave it unstated, and do not default to the same theme for every combination you return.

Rules about wood:
- This studio sells tile and stone. It does not sell timber, and it does not want a wood look in a board. Do NOT choose a wood-effect, plank, parquet, oak, teak, walnut or any other timber-imitating product for any role, however well it would suit the room — a board built on one quotes the client a material nobody here can supply.
- Judge this from the product's own name and collection as much as its recorded type: a tile named for a wood, a timber or a plank is a wood-effect tile whether or not the list says so.
- If the stock that fits the brief is mostly wood-effect, say that plainly in "reason_for_selection" and build the combination from what is left, rather than including one to fill a role.

Rules for the Black & White theme specifically:
- Both ends of the palette must be ACTUAL SELECTED TILE PRODUCTS. A combination for this theme needs at least one light tile (white, ivory, bianco, cream) AND at least one dark tile (black, charcoal, espresso), chosen from the list below.
- White arriving only as a wash basin, a towel, sanitaryware, a lighting fixture, a painted wall or the background does NOT count. The contrast has to be something this studio sells, because the client will ask for it.
- Judge a product's tone from its name and collection as much as from its recorded colour: a tile named Bianco, Carrara, Statuario or Ivory is a light tile whether or not the list records a colour for it, and one named Nero, Marquina or Charcoal is a dark one.
- This applies to EVERY combination you return, independently. Two all-dark boards are not a Black & White pair.
- If the list genuinely holds only one end of the palette, say so plainly in "reason_for_selection" and build what the stock allows. Do not pull in an unrelated product just to add a colour.

Rules about which tile may take which role:
- "base" is the plain field of the room. It must be a tile listed as type=BASE or type=LARGE_FORMAT_BASE — a quiet surface, plain or softly veined.
- "highlight", "accent" and "border" are the decorated roles. A highlight is a DESIGNER tile: it must be a tile listed as type=HIGHLIGHTER, type=ACCENT or type=BORDER. Never nominate a plain type=BASE tile as the highlight, and never put a decorated tile in the base role — a board whose highlight is plainer than its base is the wrong way round.
- If no decorated tile is listed at all, return the base alone and say so in reason_for_selection. Do not promote a base tile into a decorated role to fill the shape.

Rules about the tile list itself:
- A tile marked batch=LATEST came from the most recent catalog extraction. Those products have not been classified yet, which is why their finish, colour and room are missing from the list — that means "not recorded", never "unsuitable". Judge them on their name, brand, size and type, exactly as seriously as the older products whose attributes are filled in.
- batch=LATEST is a note about missing data, NOT a recommendation. Do not prefer a product because it was extracted recently, and do not prefer one because it has been in the catalog longer. Weigh the whole list on one question — which products make the best combination for this theme, room and budget — and let the answer fall where it falls. A board of entirely older products is right when they are the better fit, and so is a board of entirely new ones.
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
    'You are the in-house design assistant for De’vyora, a tile and stone retailer.',
    "You recommend tile combinations for customers based on the store owner's design rules below.",
    'Follow these rules exactly — they encode the owner\'s taste and years of retail experience.',
    '',
    designRulesText,
  ].join('\n');

  // WHAT THE THEME ACTUALLY ASKS FOR.
  //
  // The brief named the theme and nothing more -- "Theme: Moroccan, with
  // Ivory Matte grout." -- so the model had to recall what Moroccan
  // means in order to pick tiles for it. The ranking engine already
  // scores against the theme's finishes and colour families
  // (tileRecommendation.service.ts), but the choice between what it
  // ranks is made here, and here the theme was a word.
  //
  // The description is written for a bathroom, because that is what the
  // catalog is built around. What it is used for here is the SURFACES,
  // which is the part that holds in any room, so the line below says so
  // and the room is stated separately.
  const theme = themeBrief(brief.style);

  const briefLines = [
    `Client brief: ${brief.text}`,
    brief.customerName ? `Customer: ${brief.customerName}` : null,
    brief.style ? `Requested style: ${brief.style}` : null,
    theme
      ? `What that theme asks for — read this before choosing anything:\n${theme}\n`
        + 'Take the SURFACES from it: the colours, the patterns, the finishes and the contrast '
        + 'between them. Those are what a tile can carry. The fittings and the architecture it '
        + `mentions belong to the room${brief.room ? ` (${brief.room})` : ''}, not to the products you are choosing.`
      : null,
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

// ─────────────────────────────────────────────────────────────────────────
// Light and dark, for the one theme that is defined by having both.
//
// Read from the product's NAME as well as its recorded colour, because a
// freshly extracted row has no colour at all (backend_sync.py sends only
// code, brand, name, size and type until classification runs) -- and a
// tile called Bianco Carrara is a light tile whether or not anything has
// filled that field in yet.
// ─────────────────────────────────────────────────────────────────────────

const LIGHT_WORDS = ['white', 'ivory', 'bianco', 'cream', 'carrara', 'statuario', 'calacatta', 'alabaster'];
const DARK_WORDS = ['black', 'charcoal', 'nero', 'espresso', 'marquina', 'graphite', 'onyx', 'anthracite'];

function isLightTone(text: string): boolean {
  const lower = text.toLowerCase();
  return LIGHT_WORDS.some((w) => lower.includes(w));
}

function isDarkTone(text: string): boolean {
  const lower = text.toLowerCase();
  return DARK_WORDS.some((w) => lower.includes(w));
}

function isBlackAndWhite(style: string | undefined): boolean {
  return themeKey(style) === 'black and white' || themeKey(style) === 'black white';
}

function themeKey(style: string | undefined): string {
  if (!style) return '';
  return style.toLowerCase().replace(/[_-]/g, ' ').replace(/&/g, ' and ').split(/\s+/).join(' ');
}

// ─────────────────────────────────────────────────────────────────────────
// A MOTIF THE THEME ITSELF RULES OUT
//
// A Roman Touch bathroom came back with a brown-and-green leaf border
// running under the ceiling and across the shower wall. The border was
// a REAL selected product and the generator drew it faithfully, exactly
// as it is told to ("KEEP THE REAL PRODUCT ... never recolour, repattern
// or substitute"). Nothing was wrong downstream. It was chosen.
//
// And it was chosen because every stage that chooses is blind to what a
// pattern depicts. Ranking scores finish, colour family and type;
// `Tile` records no motif, no pattern and no description, so a product's
// NAME is the only place a motif is ever written down. A warm terracotta
// leaf decor reads as earth/warm-neutral -- the best possible colour
// match for this theme -- so the tile that clashes is the one the
// ranking likes most.
//
// A combination must carry a decorated tile (see the schema rules
// above), so the model had to pick one from what it was shown.
//
// This WARNS. It does not reject, and it does not drop the product: the
// catalog owner's own rule is to report a conflict rather than silently
// replace a selected product, and a board quoted from real stock is more
// useful than no board. Whether the catalog held a decorated tile
// WITHOUT the motif decides which of the two things it says, because
// those are different problems: one is a choice, the other is the stock.
// ─────────────────────────────────────────────────────────────────────────

const FORBIDDEN_MOTIFS: Record<string, { words: string[]; motif: string; instead: string }> = {
  'roman touch': {
    words: [
      'tropical', 'palm', 'leaf', 'leaves', 'botanic', 'floral', 'flower',
      'fern', 'monstera', 'banana', 'jungle', 'foliage', 'bloom',
    ],
    motif: 'a tropical or botanical leaf motif',
    instead: 'travertine, limestone, stone or a plain classical trim',
  },
};

function forbiddenMotif(style: string | undefined) {
  return FORBIDDEN_MOTIFS[themeKey(style)];
}

function readsAsMotif(text: string, words: string[]): boolean {
  const lower = text.toLowerCase();
  return words.some((w) => lower.includes(w));
}

export function validateCombinations(
  raw: unknown,
  consideredTileIds: Set<string>,
  // Optional so every existing caller and test keeps working; when it is
  // supplied the role check below runs, and when it is not the behaviour
  // is exactly what it was.
  typeByTileId?: Map<string, string>,
  // Optional for the same reason as typeByTileId: supplied, the Black &
  // White contrast check below runs; absent, behaviour is unchanged.
  toneByTileId?: Map<string, string>,
  style?: string,
): { combinations: GeneratedCombination[]; warnings: string[] } {
  // Only worth enforcing when the pool actually offered an alternative.
  // A catalog with nothing decorated in it must still produce a board,
  // so the rule holds the model to what was available, not to an ideal.
  const poolHasDecorated = typeByTileId
    ? [...typeByTileId.values()].some((type) => DECORATED_TYPES.has(type))
    : false;
  const warnings: string[] = [];

  // BOTH ENDS OF A BLACK & WHITE BOARD HAVE TO BE PRODUCTS.
  //
  // Nothing checked colour at all, so two all-charcoal combinations
  // passed validation and the room came back a dark grey box. The theme
  // asks for "a clear, intentional monochromatic composition", which a
  // model can satisfy in its head with white walls and a white basin --
  // neither of which this studio sells.
  //
  // A WARNING, not a rejection: rejecting would empty the board when the
  // catalog genuinely holds only one end, and regenerating would cost
  // another Gemini call. The board is built; the gap is reported.
  const monochrome = isBlackAndWhite(style);
  const poolHasLight = monochrome && toneByTileId
    ? [...toneByTileId.values()].some(isLightTone) : false;
  const poolHasDark = monochrome && toneByTileId
    ? [...toneByTileId.values()].some(isDarkTone) : false;

  // Was there a decorated tile in the catalog WITHOUT the motif this
  // theme rules out? If there was, the model had a choice and did not
  // take it. If there was not, the stock is the problem and saying "pick
  // something else" would be asking for a product that does not exist.
  const banned = forbiddenMotif(style);
  const poolHasCleanDecor = banned && typeByTileId && toneByTileId
    ? [...typeByTileId.entries()].some(([id, type]) => (
      DECORATED_TYPES.has(type) && !readsAsMotif(toneByTileId.get(id) ?? '', banned.words)
    ))
    : false;

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

    // Checked per combination, independently: two boards are only a
    // Black & White pair if each one carries the contrast itself.
    if (monochrome && toneByTileId && validTiles.length > 0) {
      const tones = validTiles.map((t) => toneByTileId.get(t.tileId) ?? '');
      const hasLight = tones.some(isLightTone);
      const hasDark = tones.some(isDarkTone);

      // Only held to what the pool could actually offer.
      if (!hasLight && poolHasLight) {
        warnings.push(
          `Combination ${index} ("${obj.board_name}"): every tile in it is dark, and the catalog `
          + 'offered a light one. Black & White needs a white or ivory TILE, not a white basin or wall.',
        );
      }
      if (!hasDark && poolHasDark) {
        warnings.push(
          `Combination ${index} ("${obj.board_name}"): every tile in it is light, and the catalog `
          + 'offered a dark one. Black & White needs a black or charcoal TILE to carry the contrast.',
        );
      }
    }

    // A MOTIF THIS THEME RULES OUT, NAMED RATHER THAN REMOVED.
    //
    // The product stays in the board. What it gets is a line saying
    // which tile carries the motif, so the studio can answer a client
    // who asks about it -- or swap it deliberately, which is their
    // decision and not this function's.
    if (banned && toneByTileId && validTiles.length > 0) {
      const offenders = validTiles.filter(
        (t) => readsAsMotif(toneByTileId.get(t.tileId) ?? '', banned.words),
      );
      if (offenders.length > 0) {
        const named = offenders
          .map((t) => `"${(toneByTileId.get(t.tileId) ?? t.tileId).trim()}" as the ${t.role}`)
          .join(', ');
        warnings.push(
          `Combination ${index} ("${obj.board_name}"): this theme rules out ${banned.motif}, `
          + `and the board carries ${named}. `
          + (poolHasCleanDecor
            ? `The catalog offered a decorated tile without it — ${banned.instead} would answer `
              + 'the theme instead. The product is kept as selected; nothing has been substituted.'
            : 'Every decorated tile in the catalog carries one, so there was nothing else to '
              + 'choose. The product is kept as selected; the gap is in the stock, not the board.'),
        );
      }
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

  // A DIFFERENT DRAW EACH TIME, FROM THE SAME CATALOG.
  //
  // The ranking's tie-break used to be the tile's NAME, which made the
  // whole pool deterministic: one catalog and one brief produced the
  // same candidates in the same order on every generation, so the model
  // saw the same products every time and picked the same ones. A
  // catalog of four hundred behaved like a catalog of eighty.
  //
  // The seed moves only the tiles that score EQUALLY -- which this
  // engine already calls equally good for the brief -- so a better tile
  // still outranks a worse one every time. What changes is which of the
  // equals gets the place.
  const tiles = await getAvailableTiles({
    brandId: input.brandId,
    room: brief.room,
    style: brief.style,
    varietySeed: Date.now() ^ Math.floor(Math.random() * 0xffffffff),
  });
  if (tiles.length === 0) {
    throw AppError.badRequest('No in-stock tiles are available for this request — check that this brand has tiles in stock, or add tiles to the catalog first.');
  }

  const prompt = buildPrompt(designRulesText, tiles, brief, combinationCount);

  const raw = await geminiClient.generateJSON<unknown>(prompt.userPrompt, { systemInstruction: prompt.systemInstruction });

  const consideredIds = new Set(tiles.map((t) => t.id));
  const typeByTileId = new Map(tiles.map((t) => [t.id, t.type]));
  // Name AND recorded colour: an unclassified row has no colour, and its
  // name is the only thing that says what tone it is.
  const toneByTileId = new Map(
    tiles.map((t) => [t.id, `${t.name ?? ''} ${t.colorTone ?? ''}`]),
  );
  const { combinations, warnings } = validateCombinations(
    raw, consideredIds, typeByTileId, toneByTileId, brief.style,
  );

  // ONE SURFACE, ONE ROLE.
  //
  // validateCombinations refuses the same tileId twice, which is not the
  // same question: a board came back with the same plain grey as its base
  // AND its border -- two rows, two product codes, two sizes, one
  // surface. Nothing in the ids could tell. So the pictures are compared,
  // and a role showing a surface an earlier role already showed is
  // dropped, exactly as a repeated id is. The first use keeps its place,
  // so the base stays the base.
  const imageByTileId = new Map(tiles.map((t) => [t.id, t.imageUrl]));
  const unreadable = new Set<string>();
  for (const combo of combinations) {
    const { duplicates, unread } = await lookalikeRoles(combo.tiles, (id) => imageByTileId.get(id));
    for (const { tile, of } of duplicates) {
      warnings.push(
        `Dropped the "${tile.role}" role — "${tile.name || tile.tileId}" shows the same surface as the "${of.role}" tile already in this board.`,
      );
    }
    if (duplicates.length > 0) {
      combo.tiles = combo.tiles.filter((t) => !duplicates.some((d) => d.tile === t));
    }
    for (const tile of unread) unreadable.add(tile.name || tile.tileId);
  }

  // A SCREEN THAT CANNOT SEE SAYS SO.
  //
  // Every picture check here fails open: a product whose image cannot be
  // fetched or decoded is kept, because "we could not look" is not
  // evidence. That is the right default and it was also completely
  // silent -- if the server cannot reach the catalog's images at all,
  // the split screen, the brand-plate screen and this duplicate check
  // are all inert and the boards come back looking exactly as though
  // they had run. This is the only trace of that, and the owner needs it
  // to tell "nothing was wrong" apart from "nothing was checked".
  if (unreadable.size > 0) {
    warnings.push(
      `Could not read the picture for ${unreadable.size} product(s) (${[...unreadable].slice(0, 5).join(', ')}${unreadable.size > 5 ? ', …' : ''}), so the image checks — split captures, brand plates and duplicate surfaces — did not run on them.`,
    );
  }

  // HOW MUCH OF THE CATALOG WAS IN CONTENTION.
  //
  // Only the best-fitting MAX_TILES_IN_PROMPT products are offered to
  // the model -- a real limit, because the whole catalog will not fit in
  // one prompt. Saying so turns "it never even looks at the rest" into a
  // number the showroom can see.
  // THE SCREEN CAN ONLY REFUSE WHAT IT CAN SEE.
  //
  // Every picture check fails open, which is right -- and it was also
  // silent, so a slate whose images could not be fetched produced boards
  // that looked exactly as though every capture had been examined. That
  // is how the split captures reached the owner's boards: not a wrong
  // measure, an unread one.
  const unread = tiles.find((t) => t.poolUnread !== undefined)?.poolUnread;
  if (unread) {
    warnings.push(
      `The image screen could not fetch ${unread} product picture(s), so split captures, brand `
      + 'plates and duplicate surfaces were not ruled out for them. They were kept, because being '
      + 'unreadable is not evidence of anything — but a bad capture reaching a board is only '
      + 'possible while this number is above zero.',
    );
  }

  const matched = tiles.find((t) => t.poolMatched !== undefined)?.poolMatched;
  if (matched !== undefined && matched > tiles.length) {
    warnings.push(
      `${matched} products matched this brief; the ${tiles.length} best-fitting were offered to the model. `
      + 'Products that score equally are drawn differently on each generation, so generating again '
      + 'offers a different set.',
    );
  }

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
