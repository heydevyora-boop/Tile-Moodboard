/**
 * Two failures the catalog owner reported, each pinned to a check.
 *
 *   1. Irregular captures -- half a tile, a furniture shot -- were picked
 *      for boards as readily as clean swatches.
 *   2. A plain tile turned up in the highlight slot and a decorated one
 *      under it.
 *
 * Neither is fixed by touching extraction. Both are fixed downstream, in
 * what the pool offers and what the ranker thinks of it, which is what
 * this measures.
 */
import {
  rankTiles,
  ensureRoleCoverage,
  declaredAspect,
  cropAspect,
  scoreCropShape,
  TileForRanking,
  RankedTile,
} from '@services/tileRecommendation.service';
import { validateCombinations } from '@services/promptBuilder.service';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass += 1;
    console.log(`OK   ${label}`);
  } else {
    fail += 1;
    console.log(`FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const tile = (over: Partial<TileForRanking> & { id: string }): TileForRanking => ({
  name: over.id,
  type: 'BASE',
  bestRoom: 'Bathroom',
  colorTone: 'Ivory',
  finish: 'matte',
  size: '600x1200',
  ...over,
});

const ranked = (over: Partial<RankedTile> & { id: string }): RankedTile => ({
  name: over.id,
  type: 'BASE',
  score: 50,
  matchReasons: [],
  fromLatestExtraction: false,
  ...over,
});

function main() {
  // ── the shape of a capture ─────────────────────────────────────────
  check('1. A size parses to its aspect', declaredAspect('600x1200') === 2, declaredAspect('600x1200'));
  check('2. ...however it is written', declaredAspect('600 × 1200 mm') === 2 && declaredAspect('1200X600') === 2);
  check('3. An unparseable size says nothing', declaredAspect('large') === null && declaredAspect(null) === null);
  check('4. A bbox gives the aspect of its region', cropAspect([0, 0, 100, 200]) === 2, cropAspect([0, 0, 100, 200]));
  check('5. A malformed bbox says nothing',
    cropAspect([0, 0, 100]) === null && cropAspect(null) === null && cropAspect([0, 0, 0, 50]) === null);

  // A clean 600x1200 swatch, cut from a 1:2 region.
  const clean = tile({ id: 'clean', size: '600x1200', imageBbox: [10, 10, 110, 210] });
  // The SAME product, captured square -- half the tile, or the tile plus
  // the furniture beside it.
  const halfShot = tile({ id: 'half', size: '600x1200', imageBbox: [10, 10, 210, 210] });

  check('6. A capture matching its product costs nothing', scoreCropShape(clean).points === 0, scoreCropShape(clean));
  check('7. A capture contradicting its product is penalised', scoreCropShape(halfShot).points < 0, scoreCropShape(halfShot));
  check('8. ...and says why, in the numbers',
    /1\.0:1 where the product is 2\.0:1/.test(scoreCropShape(halfShot).reasons[0] || ''), scoreCropShape(halfShot).reasons);

  // ── it has to change the ORDER, not just the number ────────────────
  const pool = rankTiles([halfShot, clean], { room: 'Bathroom', colorTone: 'Ivory' });
  check('9. The clean capture outranks the irregular one', pool[0].id === 'clean', pool.map((t) => `${t.id}:${t.score}`));
  check('10. ...and the irregular one is still a candidate, not deleted',
    pool.length === 2 && pool.some((t) => t.id === 'half'), pool.map((t) => t.id));

  // ── and must not punish what it cannot measure ─────────────────────
  const noData = rankTiles([
    tile({ id: 'no-bbox', size: '600x1200' }),
    tile({ id: 'no-size', size: null, imageBbox: [0, 0, 200, 200] }),
    clean,
  ], { room: 'Bathroom', colorTone: 'Ivory' });
  check('11. A tile with no bbox is not penalised',
    noData.find((t) => t.id === 'no-bbox')!.score === noData.find((t) => t.id === 'clean')!.score,
    noData.map((t) => `${t.id}:${t.score}`));
  check('12. A tile with no size is not penalised',
    noData.find((t) => t.id === 'no-size')!.score === noData.find((t) => t.id === 'clean')!.score,
    noData.map((t) => `${t.id}:${t.score}`));

  // A listello really is a sliver. Its own size says so, so it is clean.
  const listello = tile({ id: 'listello', size: '75x300', imageBbox: [0, 0, 25, 100] });
  check('13. A listello’s narrow capture agrees with its narrow size',
    scoreCropShape(listello).points === 0, scoreCropShape(listello));

  // ── the slate has to carry both kinds ──────────────────────────────
  const allPlain = Array.from({ length: 20 }, (_, i) => ranked({ id: `base-${i}`, score: 90 - i }));
  const decorated = [
    ranked({ id: 'hl-1', type: 'HIGHLIGHTER', score: 30 }),
    ranked({ id: 'hl-2', type: 'HIGHLIGHTER', score: 28 }),
    ranked({ id: 'ac-1', type: 'ACCENT', score: 22 }),
    ranked({ id: 'bd-1', type: 'BORDER', score: 18 }),
    ranked({ id: 'hl-3', type: 'HIGHLIGHTER', score: 12 }),
  ];
  const covered = ensureRoleCoverage(allPlain.slice(), [...allPlain, ...decorated]);
  const decoratedIn = covered.filter((t) => ['HIGHLIGHTER', 'ACCENT', 'BORDER'].includes(t.type));
  check('14. A slate of nothing but plain tiles gains decorated ones', decoratedIn.length >= 4, covered.map((t) => t.type));
  check('15. ...taken in merit order', decoratedIn.map((t) => t.id).join(',') === 'hl-1,hl-2,ac-1,bd-1', decoratedIn.map((t) => t.id));
  check('16. ...without growing the slate', covered.length === allPlain.length, covered.length);
  check('17. ...and the base role is not starved to pay for it',
    covered.filter((t) => t.type === 'BASE').length >= 4, covered.filter((t) => t.type === 'BASE').length);
  check('18. The strongest plain tiles survive',
    covered.some((t) => t.id === 'base-0') && covered.some((t) => t.id === 'base-1'), covered.map((t) => t.id).slice(0, 5));

  // The other direction: a slate of nothing but decor needs plain tiles.
  const allDecor = Array.from({ length: 20 }, (_, i) => ranked({ id: `hl-${i}`, type: 'HIGHLIGHTER', score: 90 - i }));
  const bases = Array.from({ length: 5 }, (_, i) => ranked({ id: `b-${i}`, score: 20 - i }));
  const covered2 = ensureRoleCoverage(allDecor.slice(), [...allDecor, ...bases]);
  check('19. A slate of nothing but decor gains plain tiles',
    covered2.filter((t) => t.type === 'BASE').length >= 4, covered2.map((t) => t.type));

  // A catalog that genuinely has only one kind must still produce a slate.
  const onlyPlain = ensureRoleCoverage(allPlain.slice(), allPlain);
  check('20. A catalog with no decorated product at all still returns its slate',
    onlyPlain.length === allPlain.length && onlyPlain.every((t) => t.type === 'BASE'), onlyPlain.length);

  // A slate that already has both is left exactly as it was.
  const mixed = [...allPlain.slice(0, 16), ...decorated.slice(0, 4)];
  check('21. A slate that already carries both is untouched',
    ensureRoleCoverage(mixed.slice(), [...allPlain, ...decorated]).map((t) => t.id).join(',') === mixed.map((t) => t.id).join(','));

  // ── and with decor in the pool, the role guard bites ───────────────
  const types = new Map<string, string>([
    ['base-x', 'BASE'],
    ['hl-x', 'HIGHLIGHTER'],
  ]);
  const swapped = validateCombinations([{
    board_name: 'Swapped',
    tiles: [
      { role: 'base', tileId: 'hl-x', name: 'Decor' },
      { role: 'highlight', tileId: 'base-x', name: 'Plain' },
    ],
    grout_recommendation: 'Ivory',
    rooms_suitable: ['BATHROOM'],
    reason_for_selection: 'x',
  }], new Set(['base-x', 'hl-x']), types);

  // Both roles are refused, which leaves nothing of the board -- so it
  // does not reach the client at all, rather than reaching it swapped.
  check('22. A swapped board does not survive validation',
    swapped.combinations.length === 0, swapped.combinations);
  check('23. The decorated tile is named as refused for the base slot',
    swapped.warnings.some((w) => /dropped the "base" role.*hl-x.*decorated/.test(w)), swapped.warnings);
  check('24. The plain tile is named as refused for the highlight slot',
    swapped.warnings.some((w) => /dropped the "highlight" role.*base-x.*plain/.test(w)), swapped.warnings);

  const correct = validateCombinations([{
    board_name: 'Right way round',
    tiles: [
      { role: 'base', tileId: 'base-x', name: 'Plain' },
      { role: 'highlight', tileId: 'hl-x', name: 'Decor' },
    ],
    grout_recommendation: 'Ivory',
    rooms_suitable: ['BATHROOM'],
    reason_for_selection: 'x',
  }], new Set(['base-x', 'hl-x']), types);
  check('25. The right way round passes untouched',
    correct.combinations[0].tiles.length === 2 && correct.warnings.length === 0, correct);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main();
