"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDurationMs = parseDurationMs;
exports.addDuration = addDuration;
const UNIT_MS = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
};
function parseDurationMs(duration) {
    const match = /^(\d+)\s*(ms|s|m|h|d|w)$/i.exec(duration.trim());
    if (!match) {
        throw new Error(`Invalid duration string: "${duration}". Expected formats like "15m", "1h", "7d".`);
    }
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    return value * UNIT_MS[unit];
}
function addDuration(base, duration) {
    return new Date(base.getTime() + parseDurationMs(duration));
}
//# sourceMappingURL=duration.js.map