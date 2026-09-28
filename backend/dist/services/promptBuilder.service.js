"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getLiveDesignRulesText = getLiveDesignRulesText;
exports.getAvailableTiles = getAvailableTiles;
exports.resolveBriefContext = resolveBriefContext;
exports.buildPrompt = buildPrompt;
exports.validateCombinations = validateCombinations;
exports.generateCombinations = generateCombinations;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const activityLog_service_1 = require("./activityLog.service");
const gemini_service_1 = require("./gemini.service");
const tileRecommendation_service_1 = require("./tileRecommendation.service");
const settings_service_1 = require("./settings.service");
async function getLiveDesignRulesText() {
    const latest = await connection_1.prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
    if (!latest) {
        throw AppError_1.AppError.badRequest('No design rules have been published yet. Publish rules in Design Rules before generating mood boards.');
    }
    return latest.fullContent;
}
const MAX_TILES_IN_PROMPT = 80;
async function getAvailableTiles(filter) {
    const ranked = await (0, tileRecommendation_service_1.getRecommendedTiles)(connection_1.prisma, {
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
    }));
}
async function resolveBriefContext(input, defaults) {
    let customerName;
    let style = input.style;
    let room = input.room;
    let budget = input.budget;
    if (input.customerId) {
        const customer = await connection_1.prisma.customer.findUnique({ where: { id: input.customerId } });
        if (!customer)
            throw AppError_1.AppError.notFound('Customer not found');
        customerName = customer.name;
        style = style ?? customer.preferredStyle ?? undefined;
        room = room ?? customer.preferredRoom ?? undefined;
        budget = budget ?? customer.budget ?? undefined;
    }
    style = style ?? (defaults?.defaultStyleTag ? defaults.defaultStyleTag.toUpperCase() : undefined);
    room = room ?? (defaults?.defaultRoomType ? defaults.defaultRoomType.toUpperCase() : undefined);
    return { text: input.text, style, room, budget, customerName };
}
function formatTileForPrompt(t) {
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
function buildPrompt(designRulesText, tiles, brief, combinationCount) {
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
    ].filter((line) => line !== null);
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
const VALID_ROLES = new Set(['base', 'highlight', 'border', 'accent']);
function validateCombinations(raw, consideredTileIds) {
    const warnings = [];
    if (!Array.isArray(raw)) {
        throw AppError_1.AppError.internal('Gemini response was not a JSON array as instructed');
    }
    const combinations = [];
    raw.forEach((item, index) => {
        if (typeof item !== 'object' || item === null) {
            warnings.push(`Combination ${index}: not an object, skipped`);
            return;
        }
        const obj = item;
        if (typeof obj.board_name !== 'string' || !Array.isArray(obj.tiles)) {
            warnings.push(`Combination ${index}: missing board_name or tiles array, skipped`);
            return;
        }
        const validTiles = [];
        for (const tileRaw of obj.tiles) {
            if (typeof tileRaw !== 'object' || tileRaw === null)
                continue;
            const t = tileRaw;
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
            validTiles.push({ role: role, tileId, name: typeof t.name === 'string' ? t.name : '' });
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
            rooms_suitable: Array.isArray(obj.rooms_suitable) ? obj.rooms_suitable.filter((r) => typeof r === 'string') : [],
            reason_for_selection: typeof obj.reason_for_selection === 'string' ? obj.reason_for_selection : '',
        });
    });
    return { combinations, warnings };
}
async function generateCombinations(input, actorId, req) {
    const rulesSettings = await (0, settings_service_1.getSettings)('rules');
    const [designRulesText, brief] = await Promise.all([
        getLiveDesignRulesText(),
        resolveBriefContext(input, { defaultRoomType: rulesSettings.defaultRoomType, defaultStyleTag: rulesSettings.defaultStyleTag }),
    ]);
    const combinationCount = input.combinationCount ?? rulesSettings.defaultMaxCombinations;
    const tiles = await getAvailableTiles({ brandId: input.brandId, room: brief.room, style: brief.style });
    if (tiles.length === 0) {
        throw AppError_1.AppError.badRequest('No in-stock tiles are available for this request — check that this brand has tiles in stock, or add tiles to the catalog first.');
    }
    const prompt = buildPrompt(designRulesText, tiles, brief, combinationCount);
    const raw = await gemini_service_1.geminiClient.generateJSON(prompt.userPrompt, { systemInstruction: prompt.systemInstruction });
    const consideredIds = new Set(tiles.map((t) => t.id));
    const { combinations, warnings } = validateCombinations(raw, consideredIds);
    if (tiles.length < rulesSettings.defaultMinTiles) {
        warnings.push(`Only ${tiles.length} tile(s) matched this brief — fewer than the configured minimum of ${rulesSettings.defaultMinTiles} (Settings > Default Rules).`);
    }
    const catalogGroupByTileId = new Map(tiles.map((t) => [t.id, t.catalogGroup]));
    const usedCatalogGroups = new Set();
    for (const combo of combinations) {
        for (const tileRef of combo.tiles) {
            const group = catalogGroupByTileId.get(tileRef.tileId);
            if (group)
                usedCatalogGroups.add(group);
        }
    }
    if (usedCatalogGroups.size < rulesSettings.defaultMinCatalogs) {
        warnings.push(`Only ${usedCatalogGroups.size} distinct catalog(s) represented across the generated boards — fewer than the configured minimum of ${rulesSettings.defaultMinCatalogs} (Settings > Default Rules).`);
    }
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'mood_board.prompt_generated',
        entityType: 'MoodBoard',
        metadata: { briefText: input.text, tilesConsidered: tiles.length, combinationsReturned: combinations.length, warnings },
        req,
    });
    return { prompt, combinations, warnings, tilesConsidered: tiles.length };
}
//# sourceMappingURL=promptBuilder.service.js.map