import 'tsconfig-paths/register';
import { loadImage } from '@napi-rs/canvas';
import { renderPrintBoardPng } from '../src/services/printBoardPngRenderer.service';
import { RenderTile } from '../src/services/printBoardRenderer.service';

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

const sampleTiles: RenderTile[] = [
  { role: 'base', name: 'Ivory Stone Base', brandName: 'Somany', size: '600x600mm', colorTone: 'Ivory' },
  { role: 'highlight', name: 'Rose Quartz Listello', brandName: 'RAK', size: '100x600mm', colorTone: 'Rose' },
  { role: 'border', name: 'Champagne Metallic Strip', brandName: 'RAK', size: '50x300mm', colorTone: 'Gold' },
];

async function main() {
  for (const layout of ['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE'] as const) {
    const pngBytes = await renderPrintBoardPng({
      boardName: 'Quiet Ivory Wash',
      clientBrief: 'Pink washroom, subtle style',
      groutRecommendation: 'Warm ivory, matched',
      tiles: sampleTiles,
      format: 'CASSETTE_PANEL',
      layout,
      widthValue: 2,
      heightValue: 3,
      unit: 'IN',
      dpi: 150,
    });

    check(`1.${layout} produces non-empty PNG bytes`, pngBytes.length > 500, pngBytes.length);
    check(`2.${layout} starts with real PNG magic bytes`, pngBytes.slice(0, 8).toString('hex') === '89504e470d0a1a0a');

    const img = await loadImage(pngBytes);
    check(`3.${layout} decodes to EXACTLY 300x450px (2in*150dpi, 3in*150dpi)`, img.width === 300 && img.height === 450, { width: img.width, height: img.height });
  }

  {
    const at300 = await renderPrintBoardPng({
      boardName: 'DPI Test', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles,
      format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 12, heightValue: 18, unit: 'IN', dpi: 300,
    });
    const at600 = await renderPrintBoardPng({
      boardName: 'DPI Test', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles,
      format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 12, heightValue: 18, unit: 'IN', dpi: 600,
    });

    const img300 = await loadImage(at300);
    const img600 = await loadImage(at600);

    check('4a. 300 DPI produces the expected pixel dimensions (12in*300=3600, 18in*300=5400)', img300.width === 3600 && img300.height === 5400, { width: img300.width, height: img300.height });
    check('4b. 600 DPI produces EXACTLY double the width and height of 300 DPI', img600.width === img300.width * 2 && img600.height === img300.height * 2, { w300: img300.width, w600: img600.width, h300: img300.height, h600: img600.height });
    check('4c. 600 DPI file is meaningfully larger in bytes (more actual pixel data, not a fake upscale)', at600.length > at300.length, { size300: at300.length, size600: at600.length });
  }

  // ---- The memory-safety guard: a genuinely oversized request (discovered during testing to crash the native canvas allocator) is now rejected cleanly instead ----
  {
    let threw: unknown = null;
    try {
      await renderPrintBoardPng({
        boardName: 'Too Big', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles,
        format: 'CASSETTE_PANEL', layout: 'TILE_GRID', widthValue: 4, heightValue: 8, unit: 'FT', dpi: 300,
      });
    } catch (err) {
      threw = err;
    }
    check('4d. An oversized request (4x8ft at 300 DPI = 414 megapixels) is rejected with a clear, actionable error — not a native crash', threw instanceof Error && /too large to render safely/.test(threw.message), threw instanceof Error ? threw.message : threw);
  }

  {
    const inches = await renderPrintBoardPng({ boardName: 'x', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles, format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 12, heightValue: 12, unit: 'IN', dpi: 100 });
    const feet = await renderPrintBoardPng({ boardName: 'x', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles, format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 1, heightValue: 1, unit: 'FT', dpi: 100 });
    const imgInches = await loadImage(inches);
    const imgFeet = await loadImage(feet);
    check('5. 12 inches and 1 foot produce IDENTICAL pixel dimensions at the same DPI (unit conversion is correct)', imgInches.width === imgFeet.width && imgInches.height === imgFeet.height, { inches: imgInches.width, feet: imgFeet.width });
  }

  {
    const oneTile = await renderPrintBoardPng({ boardName: 'Single', clientBrief: 'x', groutRecommendation: 'x', tiles: [sampleTiles[0]], format: 'CUSTOM', layout: 'HERO_IMAGE', widthValue: 2, heightValue: 3, unit: 'FT', dpi: 150 });
    check('6. Renders fine with only one tile', oneTile.length > 500);

    const manyTiles: RenderTile[] = Array.from({ length: 7 }, (_, i) => ({ role: 'accent', name: `Tile ${i}`, brandName: 'Somany', colorTone: 'Grey' }));
    const grid = await renderPrintBoardPng({ boardName: 'Many', clientBrief: 'x', groutRecommendation: 'x', tiles: manyTiles, format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 6, heightValue: 4, unit: 'FT', dpi: 150 });
    check('7. Renders fine with 7 tiles wrapping across grid rows', grid.length > 500);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
