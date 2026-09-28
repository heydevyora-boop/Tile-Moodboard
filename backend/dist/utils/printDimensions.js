"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toInches = toInches;
exports.toPoints = toPoints;
const POINTS_PER_INCH = 72;
const INCHES_PER_UNIT = {
    IN: 1,
    FT: 12,
    CM: 1 / 2.54,
    MM: 1 / 25.4,
};
function toInches(value, unit) {
    return value * INCHES_PER_UNIT[unit];
}
function toPoints(value, unit) {
    return toInches(value, unit) * POINTS_PER_INCH;
}
//# sourceMappingURL=printDimensions.js.map