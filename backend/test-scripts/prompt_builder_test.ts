import 'tsconfig-paths/register';
import { buildPrompt, validateCombinations, TileSummary, ClientBriefContext } from '../src/services/promptBuilder.service';

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

const sampleTiles: TileSummary[] = [
  { id: 'tile-1', name: 'Calacatta Grey', brandName: 'Somany', size: '600x600mm', finish: 'Matte', type: 'BASE', colorTone: 'Grey', bestRoom: 'Bathroom', productCode: 'SOM-1042', catalogGroup: 'catalog:somany-1', fromLatestExtraction: false },
  { id: 'tile-2', name: 'Bronze Highlighter Strip', brandName: 'Somany', size: '100x600mm', finish: 'Glossy', type: 'HIGHLIGHTER', colorTone: 'Bronze', bestRoom: 'Kitchen', productCode: 'SOM-2087', catalogGroup: 'catalog:somany-2', fromLatestExtraction: false },
];

// What a product looks like the moment it is synced out of an
// extraction: a code, a size, an image, and nothing else. backend_sync.py
// sends no finish, colour or room, so these really are absent, not blank
// strings -- which is the whole reason the marker below has to exist.
const freshlyExtractedTile: TileSummary = {
  id: 'tile-new', name: 'BR-CEREAMICS-VALUE-SERIES-CATALOGUE-LATTEST-0015', brandName: 'BR Ceramics',
  size: '1200x1800', finish: null, type: 'BASE', colorTone: null, bestRoom: null,
  productCode: 'BR-CEREAMICS-VALUE-SERIES-CATALOGUE-LATTEST-0015', catalogGroup: 'code:BR-CEREAMICS-VALUE-SERIES-CATALOGUE-LATTEST',
  fromLatestExtraction: true,
};

const sampleBrief: ClientBriefContext = { text: 'Pink washroom, female client, subtle style, mid budget', style: 'SUBTLE', room: 'BATHROOM', budget: 'Mid', customerName: 'Anjali Mehta' };

function main() {
  {
    const { systemInstruction, userPrompt } = buildPrompt('## GENERAL RULES\n- Always recommend a grout color', sampleTiles, sampleBrief, 4);

    check('1. System instruction includes the design rules text verbatim', systemInstruction.includes('Always recommend a grout color'));
    check('2. User prompt includes the client brief text', userPrompt.includes('Pink washroom, female client'));
    check('3. User prompt includes structured hints (style/room/budget/customer)', userPrompt.includes('SUBTLE') && userPrompt.includes('BATHROOM') && userPrompt.includes('Mid') && userPrompt.includes('Anjali Mehta'));
    check('4. User prompt includes every tile by id', userPrompt.includes('id="tile-1"') && userPrompt.includes('id="tile-2"'));
    check('5. User prompt includes tile metadata (brand/size/finish/color/room/code)', userPrompt.includes('brand="Somany"') && userPrompt.includes('size=600x600mm') && userPrompt.includes('code=SOM-1042'));
    check('6. User prompt reflects the requested combination count', userPrompt.includes('Generate exactly 4 distinct'));
    check('7. User prompt includes the JSON schema instructions', userPrompt.includes('"board_name"') && userPrompt.includes('"tileId"') && userPrompt.includes('Never invent a tileId'));
  }

  {
    const { userPrompt } = buildPrompt('rules', [], sampleBrief, 4);
    check('8. Empty tile list shows the fallback message', userPrompt.includes('no tiles currently in stock'));
  }

  {
    const minimalBrief: ClientBriefContext = { text: 'Just a floor for the hallway' };
    const { userPrompt } = buildPrompt('rules', sampleTiles, minimalBrief, 2);
    check('9. Minimal brief omits empty optional lines cleanly (no "undefined" leaking in)', !userPrompt.includes('undefined') && userPrompt.includes('Just a floor for the hallway'));
  }

  {
    const raw = [
      {
        board_name: 'Subtle Rose Bath',
        tiles: [{ role: 'base', tileId: 'tile-1', name: 'Calacatta Grey' }, { role: 'highlight', tileId: 'tile-2', name: 'Bronze Highlighter Strip' }],
        grout_recommendation: 'White, nearly invisible',
        rooms_suitable: ['Bathroom'],
        reason_for_selection: 'Matches the subtle style rule.',
      },
    ];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1', 'tile-2']));
    check('10a. Valid combination passes through unchanged', combinations.length === 1 && combinations[0].tiles.length === 2, combinations);
    check('10b. No warnings for a fully valid response', warnings.length === 0, warnings);
  }

  {
    const raw = [
      {
        board_name: 'Hallucinated Board',
        tiles: [
          { role: 'base', tileId: 'tile-1', name: 'Calacatta Grey' },
          { role: 'accent', tileId: 'tile-999-does-not-exist', name: 'Fake Tile' },
        ],
        grout_recommendation: 'x',
        rooms_suitable: ['Bathroom'],
        reason_for_selection: 'x',
      },
    ];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1', 'tile-2']));
    check('11a. Real tile kept, hallucinated tile dropped', combinations[0].tiles.length === 1 && combinations[0].tiles[0].tileId === 'tile-1', combinations);
    check('11b. A warning was recorded for the hallucinated tile', warnings.some((w) => w.includes('hallucinated')), warnings);
  }

  {
    const raw = [
      { board_name: 'All Fake', tiles: [{ role: 'base', tileId: 'nonexistent', name: 'x' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' },
      { board_name: 'Real One', tiles: [{ role: 'base', tileId: 'tile-1', name: 'Calacatta Grey' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' },
    ];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1']));
    check('12a. Combination with zero valid tiles is dropped entirely', combinations.length === 1 && combinations[0].board_name === 'Real One', combinations);
    check('12b. Warning explains why it was dropped', warnings.some((w) => w.includes('no valid tiles remained')), warnings);
  }

  {
    const raw = [{ board_name: 'Bad Role', tiles: [{ role: 'weird_role', tileId: 'tile-1', name: 'x' }, { role: 'base', tileId: 'tile-1', name: 'x' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' }];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1']));
    check('13a. Invalid role dropped, valid one kept', combinations[0].tiles.length === 1, combinations);
    check('13b. Warning recorded for invalid role', warnings.some((w) => w.includes('invalid role')), warnings);
  }

  {
    const raw = [{ board_name: 'No Base', tiles: [{ role: 'accent', tileId: 'tile-1', name: 'x' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' }];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1']));
    check('14a. Combination without a base tile is still kept', combinations.length === 1, combinations);
    check('14b. Warning flags the missing base tile', warnings.some((w) => w.includes('no base tile')), warnings);
  }

  {
    const raw = [null, 'not an object', { board_name: 'Missing tiles field' }, { board_name: 'OK', tiles: [{ role: 'base', tileId: 'tile-1', name: 'x' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' }];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1']));
    check('15a. Malformed entries skipped without crashing', combinations.length === 1 && combinations[0].board_name === 'OK', combinations);
    check('15b. Warnings recorded for each malformed entry', warnings.length === 3, warnings);
  }

  // ONE PRODUCT CANNOT BE TWO ROLES AT ONCE.
  //
  // Validation checked that every tileId was real and every role was
  // spelled correctly, and never that the ids differed. So
  // "base: X, highlight: X" passed silently and the board that came
  // out showed the same tile twice -- reported by the catalog owner as
  // "highlighter and base are the same tile".
  {
    const raw = [{
      board_name: 'Same Tile Twice',
      tiles: [
        { role: 'base', tileId: 'tile-1', name: 'Mozart Ivory' },
        { role: 'highlight', tileId: 'tile-1', name: 'Mozart Ivory' },
      ],
      grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x',
    }];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1', 'tile-2']));
    check('17a. The same tileId is not allowed two roles', combinations[0].tiles.length === 1, combinations[0].tiles);
    check('17b. The first role is the one kept', combinations[0].tiles[0].role === 'base', combinations[0].tiles);
    check('17c. A warning names the role that was dropped', warnings.some((w) => w.includes('already used by another role')), warnings);
  }

  {
    const raw = [{
      board_name: 'Three Distinct',
      tiles: [
        { role: 'base', tileId: 'tile-1', name: 'a' },
        { role: 'highlight', tileId: 'tile-2', name: 'b' },
        { role: 'border', tileId: 'tile-3', name: 'c' },
      ],
      grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x',
    }];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1', 'tile-2', 'tile-3']));
    check('18a. Three different tiles in three roles all survive', combinations[0].tiles.length === 3, combinations[0].tiles);
    check('18b. ...with no warnings', warnings.length === 0, warnings);
  }

  // The same tile in two SEPARATE combinations is not a duplicate --
  // one board's base may legitimately be another board's highlight.
  {
    const raw = [
      { board_name: 'A', tiles: [{ role: 'base', tileId: 'tile-1', name: 'a' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' },
      { board_name: 'B', tiles: [{ role: 'highlight', tileId: 'tile-1', name: 'a' }], grout_recommendation: 'x', rooms_suitable: [], reason_for_selection: 'x' },
    ];
    const { combinations, warnings } = validateCombinations(raw, new Set(['tile-1']));
    check('19a. The same tile may appear in two different combinations', combinations.length === 2 && combinations[0].tiles.length === 1 && combinations[1].tiles.length === 1, combinations);
    check('19b. ...and that is not warned about', !warnings.some((w) => w.includes('already used by another role')), warnings);
  }

  // The model is told the rule, so the drop above is a backstop rather
  // than the only thing holding the line.
  {
    const built = buildPrompt('rules', [], { text: 'brief' }, 1);
    check('20. The prompt tells the model each role needs a different tile', built.userPrompt.includes('Never give the same tileId two roles'), built.userPrompt.slice(-400));
  }

  {
    const { userPrompt } = buildPrompt('rules', [...sampleTiles, freshlyExtractedTile], sampleBrief, 4);
    const lines = userPrompt.split('\n');
    const freshLine = lines.find((l) => l.includes('id="tile-new"')) ?? '';
    const oldLine = lines.find((l) => l.includes('id="tile-1"')) ?? '';

    check('21a. A tile from the latest extraction is marked in the list', freshLine.includes('batch=LATEST'), freshLine);
    check('21b. An older tile carries no marker', !oldLine.includes('batch=LATEST'), oldLine);
    check('21c. The unclassified tile still shows what it does have', freshLine.includes('brand="BR Ceramics"') && freshLine.includes('size=1200x1800'), freshLine);
    check('21d. ...and does not invent the fields it lacks', !freshLine.includes('finish=') && !freshLine.includes('color=') && !freshLine.includes('room='), freshLine);
    check('21e. The prompt says a missing attribute means unrecorded, not unsuitable', userPrompt.includes('"not recorded", never "unsuitable"'), userPrompt.slice(-900));
    check('21f. The prompt requires at least one board to use the new stock', userPrompt.includes('must use a batch=LATEST product'), userPrompt.slice(-900));
    check('21g. The prompt forbids returning the same series over and over', userPrompt.includes('do not keep reusing one product series'), userPrompt.slice(-900));
  }

  {
    // With nothing newly extracted the marker must not appear at all --
    // otherwise the rule above points at a set that does not exist.
    const { userPrompt } = buildPrompt('rules', sampleTiles, sampleBrief, 4);
    check('22. No tile is marked when nothing came from a recent extraction', !userPrompt.split('Rules about the tile list')[0].includes('batch=LATEST'), userPrompt.slice(0, 600));
  }

  {
    let threw = false;
    try {
      validateCombinations({ not: 'an array' }, new Set());
    } catch {
      threw = true;
    }
    check('16. Non-array response throws instead of silently returning garbage', threw);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
