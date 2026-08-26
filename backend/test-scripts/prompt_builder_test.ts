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
  { id: 'tile-1', name: 'Calacatta Grey', brandName: 'Somany', size: '600x600mm', finish: 'Matte', type: 'BASE', colorTone: 'Grey', bestRoom: 'Bathroom', productCode: 'SOM-1042' },
  { id: 'tile-2', name: 'Bronze Highlighter Strip', brandName: 'Somany', size: '100x600mm', finish: 'Glossy', type: 'HIGHLIGHTER', colorTone: 'Bronze', bestRoom: 'Kitchen', productCode: 'SOM-2087' },
];

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
