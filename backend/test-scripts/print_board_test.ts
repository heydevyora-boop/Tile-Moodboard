import 'tsconfig-paths/register';
import { PDFDocument } from 'pdf-lib';
import { toPoints } from '../src/utils/printDimensions';
import { renderPrintBoardPdf, RenderTile } from '../src/services/printBoardRenderer.service';

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
  check('1. 1 inch = 72 points exactly', toPoints(1, 'IN') === 72);
  check('2. 1 foot = 864 points (12in * 72pt)', toPoints(1, 'FT') === 864);
  check('3. 1 cm ~= 28.35 points', Math.abs(toPoints(1, 'CM') - 28.3465) < 0.01, toPoints(1, 'CM'));
  check('4. 1 mm ~= 2.835 points', Math.abs(toPoints(1, 'MM') - 2.83465) < 0.01, toPoints(1, 'MM'));
  check('5. 4ft x 8ft cassette panel = 3456pt x 6912pt exactly (4*12*72, 8*12*72)', toPoints(4, 'FT') === 3456 && toPoints(8, 'FT') === 6912);

  for (const layout of ['HERO_IMAGE', 'TILE_GRID', 'SIDE_BY_SIDE', 'CASSETTE_STYLE'] as const) {
    const pdfBytes = await renderPrintBoardPdf({
      boardName: 'Quiet Ivory Wash',
      clientBrief: 'Pink washroom, female client, subtle style, mid budget',
      groutRecommendation: 'Warm ivory, matched',
      tiles: sampleTiles,
      format: 'CASSETTE_PANEL',
      layout,
      widthValue: 4,
      heightValue: 8,
      unit: 'FT',
      dpi: 300,
    });

    check(`6.${layout} produces non-empty PDF bytes`, pdfBytes.length > 500, pdfBytes.length);

    const loaded = await PDFDocument.load(pdfBytes);
    check(`7.${layout} loads back as a valid single-page PDF`, loaded.getPageCount() === 1);

    const page = loaded.getPage(0);
    const { width, height } = page.getSize();
    const expectedWidth = toPoints(4, 'FT');
    const expectedHeight = toPoints(8, 'FT');
    check(`8.${layout} page width is EXACTLY the requested 4ft (${expectedWidth}pt)`, Math.abs(width - expectedWidth) < 0.01, width);
    check(`9.${layout} page height is EXACTLY the requested 8ft (${expectedHeight}pt)`, Math.abs(height - expectedHeight) < 0.01, height);
  }

  const small = await renderPrintBoardPdf({
    boardName: 'A4 Handout', clientBrief: 'x', groutRecommendation: 'x', tiles: sampleTiles,
    format: 'MOOD_BOARD_PRINT', layout: 'TILE_GRID', widthValue: 210, heightValue: 297, unit: 'MM', dpi: 300,
  });
  const smallLoaded = await PDFDocument.load(small);
  const smallSize = smallLoaded.getPage(0).getSize();
  check('10. A4-in-mm produces a genuinely different (much smaller) page than the 4x8ft board', smallSize.width < 700 && smallSize.height < 900, smallSize);

  const oneTile = await renderPrintBoardPdf({
    boardName: 'Single Tile Test', clientBrief: 'x', groutRecommendation: 'x',
    tiles: [sampleTiles[0]], format: 'CUSTOM', layout: 'HERO_IMAGE', widthValue: 2, heightValue: 3, unit: 'FT', dpi: 300,
  });
  check('11. Renders fine with only one tile (no highlight/border)', oneTile.length > 500);

  const manyTiles: RenderTile[] = Array.from({ length: 7 }, (_, i) => ({ role: 'accent', name: `Tile ${i}`, brandName: 'Somany', colorTone: 'Grey' }));
  const grid = await renderPrintBoardPdf({
    boardName: 'Many Tiles', clientBrief: 'x', groutRecommendation: 'x', tiles: manyTiles,
    format: 'CUSTOM', layout: 'TILE_GRID', widthValue: 6, heightValue: 4, unit: 'FT', dpi: 300,
  });
  check('12. Renders fine with 7 tiles wrapping across grid rows', grid.length > 500);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
