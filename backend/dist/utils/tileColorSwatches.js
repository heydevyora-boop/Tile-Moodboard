"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.colorForTile = colorForTile;
exports.colorForTileCss = colorForTileCss;
const COLOR_KEYWORDS = [
    [/ivory|cream|white|bianco/i, [0.94, 0.91, 0.85]],
    [/grey|gray/i, [0.7, 0.69, 0.66]],
    [/black/i, [0.12, 0.11, 0.1]],
    [/brown|terracotta|rust/i, [0.65, 0.4, 0.27]],
    [/rose|pink/i, [0.82, 0.63, 0.62]],
    [/gold|bronze|champagne|brass/i, [0.68, 0.51, 0.31]],
    [/blue|navy/i, [0.2, 0.28, 0.35]],
    [/green|emerald/i, [0.31, 0.39, 0.28]],
    [/beige/i, [0.82, 0.75, 0.63]],
];
function colorForTile(tile) {
    const text = `${tile.colorTone ?? ''} ${tile.name}`;
    for (const [pattern, color] of COLOR_KEYWORDS) {
        if (pattern.test(text))
            return color;
    }
    return [0.72, 0.68, 0.6];
}
function colorForTileCss(tile) {
    const [r, g, b] = colorForTile(tile);
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
//# sourceMappingURL=tileColorSwatches.js.map