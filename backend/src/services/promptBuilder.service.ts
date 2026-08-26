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
- "name" should match the tile's listed name, for readability.
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
export function validateCombinations(raw: unknown, consideredTileIds: Set<string>): { combinations: GeneratedCombination[]; warnings: string[] } {
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
    for (const tileRaw of obj.tiles) {
      if (typeof tileRaw !== 'object' || tileRaw === null) continue;
      const t = tileRaw as Record<string, unknown>;
      const role = typeof t.role === 'string' ? t.role : '';
      const tileId = typeof t.tileId === 'string' ? t.tileId : '';

      if (!VALID_ROLES.has(role)) {
        warnings.push(`Combination ${index}: dropped a tile with invalid role "${role}"`);
        continue;
      }
      if (!consideredTileIds.has(tileId)) {
        warnings.push(`Combination ${index}: dropped tileId "${tileId}" — not in the tile list we provided (likely hallucinated)`);
        continue;
      }
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
  const { combinations, warnings } = validateCombinations(raw, consideredIds);

  if (tiles.length < rulesSettings.defaultMinTiles) {
    warnings.push(`Only ${tiles.length} tile(s) matched this brief — fewer than the configured minimum of ${rulesSettings.defaultMinTiles} (Settings > Default Rules).`);
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
