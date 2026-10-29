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
    // What 21f used to assert -- that at least one board MUST use new
    // stock -- is gone on purpose. The marker explains blank fields; it
    // does not ask for the product to be picked. See 28a-28f.
    check('21f. The marker does not ask for the new tile to be chosen',
      !userPrompt.includes('must use a batch=LATEST product'), userPrompt.slice(-900));
    check('21g. The prompt forbids returning the same series over and over', userPrompt.includes('do not keep reusing one product series'), userPrompt.slice(-900));
  }

  {
    // With nothing newly extracted the marker must not appear at all --
    // otherwise the rule above points at a set that does not exist.
    const { userPrompt } = buildPrompt('rules', sampleTiles, sampleBrief, 4);
  {
    // The catalog owner's complaint: a board came back with the plain
    // tile as the highlight and the decorated one underneath it.
    const types = new Map([['tile-1', 'BASE'], ['tile-2', 'HIGHLIGHTER'], ['tile-new', 'BASE']]);
    const ids = new Set(['tile-1', 'tile-2', 'tile-new']);

    const swapped = [{
      board_name: 'Wrong Way Round',
      tiles: [
        { role: 'base', tileId: 'tile-2', name: 'Bronze Highlighter Strip' },
        { role: 'highlight', tileId: 'tile-1', name: 'Calacatta Grey' },
      ],
      grout_recommendation: 'Ivory', rooms_suitable: ['BATHROOM'], reason_for_selection: 'x',
    }];
    const { combinations, warnings } = validateCombinations(swapped, ids, types);
    check('23a. A plain BASE tile is refused the highlight role',
      !combinations[0] || !combinations[0].tiles.some((t) => t.role === 'highlight'), combinations[0]);
    check('23b. ...and a decorated tile is refused the base role',
      !combinations[0] || !combinations[0].tiles.some((t) => t.role === 'base'), combinations[0]);
    check('23c. The warning says a highlight has to be a designer tile',
      warnings.some((w) => w.includes('designer tile')), warnings);
    check('23d. ...and says the decorated one belongs in the highlight',
      warnings.some((w) => w.includes('belongs in the highlight')), warnings);

    const right = [{
      board_name: 'Right Way Round',
      tiles: [
        { role: 'base', tileId: 'tile-1', name: 'Calacatta Grey' },
        { role: 'highlight', tileId: 'tile-2', name: 'Bronze Highlighter Strip' },
      ],
      grout_recommendation: 'Ivory', rooms_suitable: ['BATHROOM'], reason_for_selection: 'x',
    }];
    const ok = validateCombinations(right, ids, types);
    check('24a. The right way round passes untouched', ok.combinations[0].tiles.length === 2, ok.combinations[0]);
    check('24b. ...with no warnings', ok.warnings.length === 0, ok.warnings);

    // A catalog with nothing decorated in it must still produce a board.
    const plainOnly = new Map([['tile-1', 'BASE'], ['tile-new', 'BASE']]);
    const fallback = validateCombinations([{
      board_name: 'Plain Catalog',
      tiles: [
        { role: 'base', tileId: 'tile-1', name: 'Calacatta Grey' },
        { role: 'highlight', tileId: 'tile-new', name: 'BR-CEREAMICS' },
      ],
      grout_recommendation: 'Ivory', rooms_suitable: ['BATHROOM'], reason_for_selection: 'x',
    }], new Set(['tile-1', 'tile-new']), plainOnly);
    check('25. With no decorated tile in the pool at all, the board still stands',
      fallback.combinations.length === 1 && fallback.combinations[0].tiles.length === 2, fallback);

    // Without the map, behaviour is exactly what it was.
    const legacy = validateCombinations(swapped, ids);
    check('26. Omitting the type map leaves the old behaviour untouched',
      legacy.combinations[0].tiles.length === 2, legacy.combinations[0]);
  }

  {
    const { userPrompt } = buildPrompt('rules', sampleTiles, sampleBrief, 4);
    check('27a. The prompt says a highlight must be a designer tile',
      userPrompt.includes('A highlight is a DESIGNER tile'), userPrompt.slice(-1200));
    check('27b. ...and names the types that may take it',
      userPrompt.includes('type=HIGHLIGHTER, type=ACCENT or type=BORDER'));
    check('27c. ...and forbids the swap outright',
      userPrompt.includes('a board whose highlight is plainer than its base is the wrong way round'));
    check('27d. ...and says what to do when nothing decorated is listed',
      userPrompt.includes('Do not promote a base tile into a decorated role'));

    // ── OLD AND NEW STOCK WEIGHED THE SAME ──────────────────────────
    //
    // The prompt used to order the model to spend at least one
    // combination on a batch=LATEST product whenever any were listed.
    // That is a preference for recency, not for fit, and it is what
    // made boards come back built from the newest extraction.
    check('28a. The prompt no longer mandates a combination built from new stock',
      !/At least one of the combinations you return must use a batch=LATEST/.test(userPrompt));
    check('28b. ...nor forbids a board made entirely of older products',
      !/built entirely from the older products/.test(userPrompt));
    check('28c. It still explains why a new tile\u2019s attributes are blank',
      userPrompt.includes('that means "not recorded", never "unsuitable"'));
    check('28d. ...and says the label is not a recommendation',
      userPrompt.includes('batch=LATEST is a note about missing data, NOT a recommendation'));
    check('28e. ...forbidding a preference in EITHER direction',
      userPrompt.includes('do not prefer one because it has been in the catalog longer'));
    check('28f. ...and blesses a board of entirely old or entirely new products',
      userPrompt.includes('A board of entirely older products is right when they are the better fit'));

    // ── THE THEME ───────────────────────────────────────────────────
    check('29a. The prompt treats the theme as a design language',
      userPrompt.includes('Read it as a design language, not as a colour filter'));
    check('29b. ...and names every theme the wizard offers',
      ['British', 'Roman Touch', 'Floral', 'Tropical', 'Geometrical', 'Metallic', 'Rustic', 'Moroccan', 'Black & White']
        .every((t) => userPrompt.includes(t)));
    check('29c. ...requires floor, wall and decorated piece to share it',
      userPrompt.includes('all have to belong to the same one'));
    check('29d. ...lets an unclassified product be read from its name',
      userPrompt.includes('A product whose attributes are blank can still be read from its name'));
    check('29e. ...asks the reason to say what makes it read as that theme',
      userPrompt.includes('what makes the combination read as that theme'));
    check('29f. ...and says to speak up when the stock cannot carry it',
      userPrompt.includes('cannot carry the theme, say that plainly'));
    check('29g. When no theme is given, the model must choose one and name it',
      userPrompt.includes('choose the theme yourself') && userPrompt.includes('name the theme you chose'));
    check('29h. ...and must not answer every combination with the same theme',
      userPrompt.includes('do not default to the same theme for every combination'));
  }

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

  // ── 30. the theme reaches the step that PICKS the tiles ───────────
  //
  // The brief named the theme and nothing more -- "Theme: Moroccan,
  // with Ivory Matte grout." -- so the model had to recall what
  // Moroccan means in order to choose tiles for it. The ranking engine
  // scores against the theme already; the choice between what it ranks
  // is made here, and here the theme was a word.
  {
    const themed = (style: string, room?: string) =>
      buildPrompt('rules', sampleTiles, { text: 'brief', style, room }, 2).userPrompt;

    const moroccan = themed('Moroccan', 'Kitchen & Dining');
    check('30a. The theme description is in the prompt',
      moroccan.includes('zellige') && moroccan.includes('cobalt-blue'), moroccan.slice(0, 200));
    check('30b. ...introduced as the specification to read first',
      moroccan.includes('What that theme asks for — read this before choosing anything'));
    check('30c. ...and no other theme’s wording is present',
      !/travertine|palm-leaf|oxblood|champagne-gold/i.test(moroccan));

    // The descriptions are written for a bathroom. The part a TILE can
    // carry is the surfaces; the fittings belong to whatever room was
    // chosen, and the prompt has to separate the two or a kitchen board
    // gets picked for a bathroom.
    check('30d. Only the surfaces are claimed for the products',
      moroccan.includes('Take the SURFACES from it'));
    check('30e. ...and the fittings are handed back to the room',
      moroccan.includes('belong to the room (Kitchen & Dining), not to the products'));

    for (const [style, word] of [
      ['British', 'oxblood'], ['Roman Touch', 'travertine'], ['Floral', 'blush-pink'],
      ['Tropical', 'palm-leaf'], ['Geometrical', 'hexagonal'], ['Metallic', 'champagne-gold'],
      ['Rustic', 'ochre'], ['Black & White', 'charcoal'],
    ] as const) {
      check(`30f. ${style} carries its own description`,
        themed(style).toLowerCase().includes(word), word);
    }

    check('30g. Every role must answer the theme, not just the decorated one',
      moroccan.includes('Every role has to answer the theme'));
    check('30h. A theme nobody offers adds no description at all',
      !themed('Brutalist').includes('What that theme asks for'));
    check('30i. ...and a brief with no theme is unchanged',
      !buildPrompt('rules', sampleTiles, { text: 'brief' }, 2).userPrompt.includes('What that theme asks for'));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
