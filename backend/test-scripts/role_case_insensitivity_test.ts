/**
 * Regression: a role differing only in letter case is the same role.
 *
 * THE FAILURE THIS COVERS
 * -----------------------
 * The visualization engine's system prompt states that every selected
 * value -- application, surface, role, style, height, joint width,
 * laying pattern -- is read case-insensitively, and that upper, lower
 * and mixed case are never a different, unrecognised or missing option.
 *
 * Two places in the backend disagreed with that, both on `role`:
 *
 *   validateCombinations checked `VALID_ROLES.has(role)` against the
 *   raw string. Gemini answering "BASE" rather than "base" -- the same
 *   word this codebase writes in caps everywhere a human reads it, and
 *   which no schema forbids it from echoing -- had its tile DROPPED as
 *   an invalid role. A board could come back with its highlight and
 *   accent silently missing, or with no base tile at all.
 *
 *   combinationTileSchema was a bare z.enum over the same lowercase
 *   words, so saving that board 400'd on a role the product considers
 *   valid. Every other case-bearing field in that file -- style, room --
 *   was already normalized with .toUpperCase(); role was the one that
 *   was not.
 *
 * WHAT THIS TEST ACTUALLY CHECKS
 * ------------------------------
 * The real validator and the real zod schema, at the two boundaries
 * where a role enters the system. It asserts on the NORMALIZED value,
 * not merely that the call survived: downstream consumers (the print
 * board renderers, the mood board's own base lookup) compare
 * `role === 'base'` exactly, so a role that is accepted but left as
 * "BASE" would pass a weaker test and still render a board with no base
 * tile on it.
 *
 * Run:  npx ts-node -r tsconfig-paths/register \
 *         test-scripts/role_case_insensitivity_test.ts
 */

import { validateCombinations } from '../src/services/promptBuilder.service';
import { combinationSchema } from '../src/validators/moodBoard.validators';

const results: Array<[string, boolean, string]> = [];

function check(label: string, ok: boolean, detail = '') {
  results.push([label, Boolean(ok), detail]);
}

const POOL = new Set(['t-base', 't-high', 't-accent', 't-border']);

function combination(roles: string[]) {
  const ids = ['t-base', 't-high', 't-accent', 't-border'];
  return [{
    board_name: 'Warm Sanctuary',
    tiles: roles.map((role, i) => ({ role, tileId: ids[i], name: `Tile ${i}` })),
    grout_recommendation: 'warm grey',
    rooms_suitable: ['BATHROOM'],
    reason_for_selection: 'test',
  }];
}

// ------------------------------------------------------------------
// The validator, which is where an LLM's answer enters the system.
// ------------------------------------------------------------------

const shouted = validateCombinations(
  combination(['BASE', 'HIGHLIGHT', 'ACCENT', 'BORDER']),
  POOL,
);

check(
  'an all-caps combination is kept, not dropped',
  shouted.combinations.length === 1,
  JSON.stringify(shouted.warnings),
);

check(
  'every all-caps tile survives -- none dropped as an invalid role',
  shouted.combinations[0]?.tiles.length === 4,
  `kept ${shouted.combinations[0]?.tiles.length}`,
);

check(
  'no warning claims a valid role was invalid',
  !shouted.warnings.some((w) => w.includes('invalid role')),
  JSON.stringify(shouted.warnings),
);

check(
  'the roles are normalized to lowercase, so role === "base" still matches',
  JSON.stringify(shouted.combinations[0]?.tiles.map((t) => t.role))
    === JSON.stringify(['base', 'highlight', 'accent', 'border']),
  JSON.stringify(shouted.combinations[0]?.tiles.map((t) => t.role)),
);

check(
  'no "no base tile" warning is raised for an all-caps BASE',
  !shouted.warnings.some((w) => w.includes('no base tile')),
  JSON.stringify(shouted.warnings),
);

const mixed = validateCombinations(
  combination(['Base', ' hIgHlIgHt ', 'Accent']),
  POOL,
);

check(
  'mixed case and surrounding whitespace normalize too',
  JSON.stringify(mixed.combinations[0]?.tiles.map((t) => t.role))
    === JSON.stringify(['base', 'highlight', 'accent']),
  JSON.stringify(mixed.combinations[0]?.tiles.map((t) => t.role)),
);

// A role nobody defined is still a rejection. Widening the gate on case
// must not widen it on meaning.
const bogus = validateCombinations(combination(['base', 'SPARKLE']), POOL);

check(
  'an undefined role is still dropped',
  bogus.combinations[0]?.tiles.length === 1,
  `kept ${bogus.combinations[0]?.tiles.length}`,
);

check(
  '...and still says so',
  bogus.warnings.some((w) => w.includes('invalid role')),
  JSON.stringify(bogus.warnings),
);

// ------------------------------------------------------------------
// The save schema, which is where a reviewed board enters the system.
// ------------------------------------------------------------------

const parsedUpper = combinationSchema.safeParse(combination(['BASE', 'HIGHLIGHT'])[0]);

check(
  'the save schema accepts an all-caps role',
  parsedUpper.success,
  parsedUpper.success ? '' : JSON.stringify(parsedUpper.error.issues),
);

check(
  '...and stores it lowercased',
  parsedUpper.success
    && JSON.stringify(parsedUpper.data.tiles.map((t) => t.role))
      === JSON.stringify(['base', 'highlight']),
  parsedUpper.success ? JSON.stringify(parsedUpper.data.tiles.map((t) => t.role)) : '',
);

const parsedBogus = combinationSchema.safeParse(combination(['SPARKLE'])[0]);

check(
  'the save schema still refuses an undefined role',
  !parsedBogus.success,
);

// ------------------------------------------------------------------
let failures = 0;
for (const [label, ok, detail] of results) {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? `  [${detail}]` : ''}`);
  }
}
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures ? 1 : 0);
