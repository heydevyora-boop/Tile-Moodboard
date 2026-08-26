export type DiffLineType = 'unchanged' | 'added' | 'removed';

export interface DiffLine {
  type: DiffLineType;
  value: string;
}

/**
 * Classic LCS-based line diff. O(n*m) — fine here since design rule
 * documents are at most a few hundred lines, not the kind of thing that
 * needs a streaming/Myers-algorithm implementation.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const n = oldLines.length;
  const m = newLines.length;

  // dp[i][j] = length of the LCS of oldLines[i:] and newLines[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: 'unchanged', value: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: 'removed', value: oldLines[i] });
      i++;
    } else {
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
