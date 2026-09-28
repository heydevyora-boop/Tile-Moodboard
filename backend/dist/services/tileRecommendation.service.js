"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.rankTiles = rankTiles;
exports.getRecommendedTiles = getRecommendedTiles;
const STYLE_PROFILES = {
    LUXURY: { finishes: ['glossy', 'polished'], colorFamilies: ['gold', 'dark', 'cool-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },
    SUBTLE: { finishes: ['matte'], colorFamilies: ['warm-neutral', 'cool-neutral'], types: ['BASE'] },
    BOLD: { finishes: ['glossy', 'textured'], colorFamilies: ['dark', 'earth', 'blue', 'green'], types: ['ACCENT', 'HIGHLIGHTER'] },
    TRADITIONAL: { finishes: ['matte', 'textured'], colorFamilies: ['earth', 'warm-neutral'], types: ['BASE', 'BORDER'] },
    FEMININE: { finishes: ['glossy', 'polished'], colorFamilies: ['rose', 'gold', 'warm-neutral'], types: ['HIGHLIGHTER', 'ACCENT'] },
};
const COLOR_FAMILIES = {
    'warm-neutral': ['ivory', 'cream', 'beige', 'champagne', 'tan'],
    'cool-neutral': ['grey', 'gray', 'white', 'bianco', 'silver'],
    dark: ['black', 'charcoal', 'espresso'],
    earth: ['brown', 'terracotta', 'rust', 'bronze', 'copper'],
    rose: ['rose', 'pink', 'blush'],
    gold: ['gold', 'brass', 'champagne'],
    blue: ['blue', 'navy', 'teal'],
    green: ['green', 'emerald', 'sage'],
};
function familiesFor(colorTone) {
    if (!colorTone)
        return [];
    const lower = colorTone.toLowerCase();
    return Object.entries(COLOR_FAMILIES)
        .filter(([, keywords]) => keywords.some((k) => lower.includes(k)))
        .map(([family]) => family);
}
function scoreRoom(tile, room) {
    if (!room)
        return { points: 0, reasons: [] };
    if (!tile.bestRoom)
        return { points: 8, reasons: ['Versatile — no specific room restriction'] };
    if (tile.bestRoom.toLowerCase() === room.toLowerCase())
        return { points: 40, reasons: [`Exact room match: ${tile.bestRoom}`] };
    return { points: -10, reasons: [] };
}
function scoreStyle(tile, style) {
    if (!style)
        return { points: 0, reasons: [] };
    const profile = STYLE_PROFILES[style.toUpperCase()];
    if (!profile)
        return { points: 0, reasons: [] };
    let points = 0;
    const reasons = [];
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
function scoreColor(tile, requestedColor) {
    if (!requestedColor || !tile.colorTone)
        return { points: 0, reasons: [] };
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
function rankTiles(tiles, criteria) {
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
function sourceGroupKey(tile) {
    if (tile.catalogId)
        return `catalog:${tile.catalogId}`;
    if (tile.collection)
        return `collection:${tile.collection}`;
    const codePrefix = tile.productCode?.match(/^(.+)-\d{3,}$/)?.[1];
    if (codePrefix)
        return `code:${codePrefix}`;
    return `brand:${tile.brandId}`;
}
function interleaveBySource(ranked, sourceOf, limit) {
    if (ranked.length <= limit)
        return ranked;
    const bySource = new Map();
    for (const tile of ranked) {
        const key = sourceOf(tile.id);
        const group = bySource.get(key);
        if (group)
            group.push(tile);
        else
            bySource.set(key, [tile]);
    }
    const groups = [...bySource.values()];
    const selected = [];
    for (let depth = 0; selected.length < limit; depth += 1) {
        let progressed = false;
        for (const group of groups) {
            if (depth >= group.length)
                continue;
            selected.push(group[depth]);
            progressed = true;
            if (selected.length >= limit)
                break;
        }
        if (!progressed)
            break;
    }
    return selected;
}
async function getRecommendedTiles(prisma, filter) {
    const tiles = await prisma.tile.findMany({
        where: {
            inStock: true,
            OR: [{ sheetRowRef: { not: null } }, { catalogId: { not: null } }],
            ...(filter.brandId ? { brandId: filter.brandId } : {}),
            ...(filter.type ? { type: filter.type } : {}),
        },
        include: { brand: { select: { name: true } } },
    });
    const forRanking = tiles.map((t) => ({
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
    const sourceByTileId = new Map(tiles.map((t) => [t.id, sourceGroupKey(t)]));
    const selected = interleaveBySource(ranked, (id) => sourceByTileId.get(id) ?? `tile:${id}`, filter.limit ?? 20);
    return selected.map((t) => ({ ...t, catalogGroup: sourceByTileId.get(t.id) ?? `tile:${t.id}` }));
}
//# sourceMappingURL=tileRecommendation.service.js.map