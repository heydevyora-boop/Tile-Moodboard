const POINTS_PER_INCH = 72;

const INCHES_PER_UNIT: Record<'FT' | 'IN' | 'CM' | 'MM', number> = {
  IN: 1,
  FT: 12,
  CM: 1 / 2.54,
  MM: 1 / 25.4,
};

/** Converts a physical dimension into inches — the basis for both toPoints() (PDF) and pixel math (PNG, where pixels = inches * dpi). */
export function toInches(value: number, unit: 'FT' | 'IN' | 'CM' | 'MM'): number {
  return value * INCHES_PER_UNIT[unit];
}

/**
 * Converts a physical dimension into PDF points (72 points per inch,
 * the unit every PDF page-size value is expressed in) — this is what
 * makes "exact print dimensions" actually exact rather than approximate.
 * A page built this way opens at precisely the requested physical size
 * in any PDF viewer or RIP software, regardless of screen DPI.
 */
export function toPoints(value: number, unit: 'FT' | 'IN' | 'CM' | 'MM'): number {
  return toInches(value, unit) * POINTS_PER_INCH;
}
