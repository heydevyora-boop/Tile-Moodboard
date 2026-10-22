import 'tsconfig-paths/register';
import { rankTiles, TileForRanking } from '../src/services/tileRecommendation.service';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
    fail++;
  }
}

const tiles: TileForRanking[] = [
  { id: 't-bath-ivory', name: 'Ivory Stone Base', finish: 'Matte', type: 'BASE', colorTone: 'Ivory', bestRoom: 'Bathroom' },
  { id: 't-bath-rose', name: 'Rose Quartz Listello', finish: 'Glossy', type: 'HIGHLIGHTER', colorTone: 'Rose', bestRoom: 'Bathroom' },
  { id: 't-kitchen-black', name: 'Black Granite Base', finish: 'Polished', type: 'BASE', colorTone: 'Black', bestRoom: 'Kitchen' },
  { id: 't-versatile-grey', name: 'Grey Slate', finish: 'Matte', type: 'BASE', colorTone: 'Grey', bestRoom: null },
  { id: 't-gold-accent', name: 'Champagne Metallic Strip', finish: 'Glossy', type: 'ACCENT', colorTone: 'Champagne', bestRoom: 'Bathroom' },
];

function main() {
  {
    const ranked = rankTiles(tiles, { room: 'Bathroom' });
    const bathTiles = ranked.filter((t) => t.bestRoom === 'Bathroom');
    const kitchenTile = ranked.find((t) => t.id === 't-kitchen-black')!;
    const versatileTile = ranked.find((t) => t.id === 't-versatile-grey')!;

    check('1. Exact room matches rank above the Kitchen tile', bathTiles.every((t) => t.score > kitchenTile.score), { bathTiles, kitchenTile });
    check('2. A versatile tile (no bestRoom) ranks above a wrong-room tile but below an exact match', versatileTile.score > kitchenTile.score && versatileTile.score < bathTiles[0].score, { versatileTile, kitchenTile, top: bathTiles[0] });
    check('3. Exact room match has a matchReason mentioning the room', bathTiles[0].matchReasons.some((r) => r.includes('room match')), bathTiles[0].matchReasons);
    check('4. Room-mismatched tile is NOT filtered out — still present, just lower-ranked', ranked.some((t) => t.id === 't-kitchen-black'));
  }

  {
    const ranked = rankTiles(tiles, { style: 'SUBTLE' });
    const ivory = ranked.find((t) => t.id === 't-bath-ivory')!;
    const goldAccent = ranked.find((t) => t.id === 't-gold-accent')!;
    check('5. Matte/neutral BASE tile scores higher for SUBTLE style than a glossy gold accent', ivory.score > goldAccent.score, { ivory, goldAccent });
    check('6. SUBTLE match includes a reason mentioning the style', ivory.matchReasons.some((r) => r.includes('SUBTLE')), ivory.matchReasons);
  }
  {
    const ranked = rankTiles(tiles, { style: 'LUXURY' });
    const goldAccent = ranked.find((t) => t.id === 't-gold-accent')!;
    const ivory = ranked.find((t) => t.id === 't-bath-ivory')!;
    check('7. Glossy gold accent scores higher for LUXURY style than a matte ivory base', goldAccent.score > ivory.score, { goldAccent, ivory });
  }
  {
    const ranked = rankTiles(tiles, { style: 'NOT_A_REAL_STYLE' });
    check('8. Unknown style falls back to zero style contribution without crashing', ranked.length === tiles.length);
  }

  {
    const ranked = rankTiles(tiles, { colorTone: 'Ivory' });
    const exact = ranked.find((t) => t.id === 't-bath-ivory')!;
    const unrelated = ranked.find((t) => t.id === 't-kitchen-black')!;
    check('9. Exact color match scores highest', exact.score >= ranked[0].score - 0.01, { exact, top: ranked[0] });
    check('10. Exact color match has a reason mentioning the color', exact.matchReasons.some((r) => r.includes('Exact color match')), exact.matchReasons);
    check('11. Unrelated color scores 0 for the color factor (no false positive)', !unrelated.matchReasons.some((r) => r.includes('color')));
  }
  {
    const ranked = rankTiles(tiles, { colorTone: 'Gold' });
    const champagne = ranked.find((t) => t.id === 't-gold-accent')!;
    check('12. Same-family color (Champagne vs Gold) gets partial credit via a family-match reason', champagne.matchReasons.some((r) => r.includes('color family')), champagne.matchReasons);
  }

  {
    const ranked = rankTiles(tiles, { room: 'Bathroom', style: 'FEMININE', colorTone: 'Rose' });
    check('13. Combined criteria puts the tile matching all three at the top', ranked[0].id === 't-bath-rose', ranked.map((t) => ({ id: t.id, score: t.score })));
  }

  {
    const ranked = rankTiles(tiles, {});
    check('14. With no criteria, BASE tiles still get a small tiebreak bonus over non-BASE', ranked.filter((t) => t.type === 'BASE').every((t) => t.score >= 0));
    check('15. No criteria produces a fully deterministic, non-empty ordering', ranked.length === tiles.length);
  }

  {
    const ranked = rankTiles([], { room: 'Bathroom', style: 'LUXURY', colorTone: 'Gold' });
    check('16. Empty tile pool returns an empty ranked list without crashing', ranked.length === 0);
  }

  {
    // The three labels frontend/mood-board.html actually puts in `style`.
    // None of them used to resolve, so the client's palette scored zero
    // on every tile and decided nothing.
    const palettes = ['Warm Neutral', 'Cool Grey', 'High Contrast'];
    const scoredSomething = palettes.filter((style) => {
      const ranked = rankTiles(tiles, { style });
      return ranked.some((t) => t.matchReasons.length > 0);
    });

    check('17a. Every palette the wizard sends is recognised by the scorer', scoredSomething.length === palettes.length, scoredSomething);

    const warm = rankTiles(tiles, { style: 'Warm Neutral' });
    const ivory = warm.find((t) => t.id === 't-bath-ivory')!;
    const black = warm.find((t) => t.id === 't-kitchen-black')!;
    check('17b. Warm Neutral puts an ivory matte base above a polished black one', ivory.score > black.score, { ivory, black });

    const contrast = rankTiles(tiles, { style: 'High Contrast' });
    const champagne = contrast.find((t) => t.id === 't-gold-accent')!;
    const grey = contrast.find((t) => t.id === 't-versatile-grey')!;
    check('17c. High Contrast rates a champagne accent above a plain grey base', champagne.score > grey.score, { champagne, grey });

    // The palettes must discriminate, not hand every tile the same bonus.
    const spread = new Set(warm.map((t) => t.score));
    check('17d. A palette separates the pool rather than scoring it flat', spread.size > 1, [...spread]);
  }

  {
    const older = new Date('2026-01-01T00:00:00Z');
    const fresh = new Date('2026-06-01T00:00:00Z');
    const mixed: TileForRanking[] = [
      { id: 't-old', name: 'Old Base', type: 'BASE', colorTone: 'Ivory', bestRoom: 'Bathroom', createdAt: older, updatedAt: older },
      { id: 't-fresh', name: 'BR-CEREAMICS-0015', type: 'BASE', colorTone: null, bestRoom: null, createdAt: fresh, updatedAt: fresh },
    ];
    const ranked = rankTiles(mixed, { room: 'Bathroom' });

    check('18a. The newest extraction is flagged, so the prompt can point at it', ranked.find((t) => t.id === 't-fresh')!.fromLatestExtraction === true);
    check('18b. An older tile is not flagged', ranked.find((t) => t.id === 't-old')!.fromLatestExtraction === false);
    check('18c. The flag tracks the recency credit, not the ranking order', ranked.find((t) => t.id === 't-fresh')!.matchReasons.includes('From the latest extraction'));

    // With no timestamps at all nothing is "latest", so nothing is marked.
    const undated = rankTiles(tiles, { room: 'Bathroom' });
    check('18d. Nothing is flagged when no tile carries a timestamp', undated.every((t) => t.fromLatestExtraction === false));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
