"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.diffLines = diffLines;
function diffLines(oldText, newText) {
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const n = oldLines.length;
    const m = newLines.length;
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const result = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (oldLines[i] === newLines[j]) {
            result.push({ type: 'unchanged', value: oldLines[i] });
            i++;
            j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            result.push({ type: 'removed', value: oldLines[i] });
            i++;
        }
        else {
            result.push({ type: 'added', value: newLines[j] });
            j++;
        }
    }
    while (i < n) {
        result.push({ type: 'removed', value: oldLines[i] });
        i++;
    }
    while (j < m) {
        result.push({ type: 'added', value: newLines[j] });
        j++;
    }
    return result;
}
//# sourceMappingURL=diffLines.js.map