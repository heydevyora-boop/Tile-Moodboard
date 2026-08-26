const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * Parses simple duration strings like "15m", "7d", "1h", "30d" into
 * milliseconds. Used wherever we need an actual expiry Date (refresh
 * tokens, password reset tokens) rather than jsonwebtoken's built-in
 * "expiresIn" string handling, which only applies to signed JWTs.
 */
export function parseDurationMs(duration: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(duration.trim());
  if (!match) {
    throw new Error(`Invalid duration string: "${duration}". Expected formats like "15m", "1h", "7d".`);
  }
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  return value * UNIT_MS[unit];
}

export function addDuration(base: Date, duration: string): Date {
  return new Date(base.getTime() + parseDurationMs(duration));
}
