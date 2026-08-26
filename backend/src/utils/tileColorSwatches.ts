export interface SwatchTile {
  name: string;
  colorTone?: string | null;
}

// Approximate swatch colors by keyword match against colorTone/name — this
// is a labeled placeholder, not a photo. Reliably fetching and decoding
// arbitrary remote/local tile images for embedding was more risk than
// this feature's scope justified; every swatch is clearly text-labeled
// with the real product name/brand/size, so nothing about which tile is
// meant is ambiguous.
const COLOR_KEYWORDS: [RegExp, [number, number, number]][] = [
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

/** Returns an RGB triple, each channel 0-1, for a tile's swatch color. */
export function colorForTile(tile: SwatchTile): [number, number, number] {
  const text = `${tile.colorTone ?? ''} ${tile.name}`;
  for (const [pattern, color] of COLOR_KEYWORDS) {
    if (pattern.test(text)) return color;
  }
  return [0.72, 0.68, 0.6]; // neutral stone fallback
}

/** Same color, formatted as a CSS/Canvas-compatible rgb() string. */
export function colorForTileCss(tile: SwatchTile): string {
  const [r, g, b] = colorForTile(tile);
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}
