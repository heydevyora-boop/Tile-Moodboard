/**
 * Regression: the history must show every generation, and the tiles.
 *
 * THE TWO FAILURES THIS COVERS
 * ----------------------------
 * The Recent Generations page showed a render, a date and a theme name,
 * and that was all. The one question anyone has of a history -- which
 * tiles is this? -- had no answer on the page, because the log kept a
 * single `productName` (the base) and nothing else, although the route
 * had already resolved every material to a real Tile row.
 *
 * And it showed the newest 30. The route took 30 rows and stopped, with
 * no way to ask for the rest and nothing on screen admitting there was
 * a rest, so a studio past its thirtieth board could not see its own
 * history.
 *
 * These are the pure halves of both fixes: what is written into the log
 * and what is read back out of it. The page that draws them is covered
 * by recent_generations_page_wiring_test.js.
 *
 * Run:  npx ts-node -r tsconfig-paths/register \
 *         test-scripts/recent_generations_test.ts
 */

import {
  GENERATION_PRODUCT_LIMIT,
  decodeDataUrl,
  generationVerdict,
  generationProducts,
  generationRow,
} from '../src/routes/ai_visualization.routes';

const results: Array<[string, boolean, string]> = [];

function check(label: string, ok: boolean, detail: unknown = '') {
  results.push([label, Boolean(ok), detail === '' ? '' : JSON.stringify(detail)]);
}

const COMBINATION = [
  {
    role: 'base',
    image_url: 'https://drive.example/base.webp',
    product_id: 'URV-0014',
    name: 'Urvi Statuario',
    size: '600x1200mm',
    finish: 'Glossy',
  },
  {
    role: 'highlight',
    image_url: 'https://drive.example/highlight.webp',
    product_id: 'DEC-0002',
    name: 'Botanical Decor',
    size: '300x600mm',
    finish: 'Matt',
  },
  {
    role: 'accent',
    image_url: 'https://drive.example/accent.webp',
    product_id: 'ACC-0007',
    name: 'Sage Colourbody',
    size: '300x300mm',
    finish: 'Matt',
  },
];

function main(): number {
  // ----------------------------------------------------------------
  // WHAT IS WRITTEN: the whole combination, in the order it was sent.
  // ----------------------------------------------------------------
  const stored = generationProducts(COMBINATION);

  check('1. every material is kept, not just the base',
    stored.length === 3, stored.map((p) => p.name));
  check('2. the base stays first, then highlight and accent',
    stored.map((p) => p.role).join(',') === 'base,highlight,accent',
    stored.map((p) => p.role));
  check('3. each one keeps its name',
    stored.map((p) => p.name).join('|') === 'Urvi Statuario|Botanical Decor|Sage Colourbody',
    stored.map((p) => p.name));
  check('4. ...its catalog image',
    stored.every((p) => p.imageUrl.startsWith('https://drive.example/')),
    stored.map((p) => p.imageUrl));
  check('5. ...and its code, size and finish',
    stored[0].code === 'URV-0014' && stored[0].size === '600x1200mm' && stored[0].finish === 'Glossy',
    stored[0]);

  // A tile row with nothing but an image still records cleanly: the card
  // falls back to the code, and absent fields must be '' and not
  // "undefined" printed into the page.
  const sparse = generationProducts([{ role: 'base', image_url: 'https://x/y.webp' }]);
  check('6. a tile with no name or size records empty strings, never "undefined"',
    sparse[0].name === '' && sparse[0].size === '' && sparse[0].finish === '' && sparse[0].code === '',
    sparse[0]);

  // ----------------------------------------------------------------
  // An inline image is NOT written. Four data: URLs in one row would be
  // megabytes of history per generation; the name is the part that
  // matters and it is kept.
  // ----------------------------------------------------------------
  const inline = generationProducts([
    { role: 'base', name: 'Inline Tile', image_url: 'data:image/png;base64,' + 'A'.repeat(5000) },
    { role: 'highlight', name: 'Long URL', image_url: 'https://x/' + 'b'.repeat(4000) },
  ]);
  check('7. a data: URL is dropped rather than written into the log',
    inline[0].imageUrl === '', inline[0].imageUrl.slice(0, 40));
  check('8. ...and so is an absurdly long one',
    inline[1].imageUrl === '', inline[1].imageUrl.length);
  check('9. ...but the tile is still recorded, with its name',
    inline.length === 2 && inline[0].name === 'Inline Tile' && inline[1].name === 'Long URL',
    inline.map((p) => p.name));

  const many = generationProducts(
    Array.from({ length: 20 }, (_, i) => ({ role: 'extra', name: `Tile ${i}`, image_url: 'https://x/t.webp' })),
  );
  check('10. a runaway combination is capped rather than unbounded',
    many.length === GENERATION_PRODUCT_LIMIT, many.length);

  check('11. no materials at all records an empty list, not a crash',
    JSON.stringify(generationProducts([])) === '[]');

  // ----------------------------------------------------------------
  // WHAT IS READ BACK: the page gets the products with the scene.
  // ----------------------------------------------------------------
  const row = generationRow({
    id: 'log-1',
    createdAt: new Date('2026-10-30T02:17:00Z'),
    user: { name: 'Priya' },
    metadata: {
      imageUrl: 'https://drive.example/scene.webp',
      imageSource: 'drive',
      productName: 'Urvi Statuario',
      room: 'Living Room',
      style: 'Floral',
      combinationName: 'Soft Botanical Garden',
      products: stored,
    },
  }) as Record<string, any>;

  check('12. the scene still reads back as it did',
    row.imageUrl === 'https://drive.example/scene.webp'
    && row.room === 'Living Room' && row.style === 'Floral'
    && row.combinationName === 'Soft Botanical Garden' && row.by === 'Priya',
    row);
  check('13. ...and now carries the products with it',
    Array.isArray(row.products) && row.products.length === 3
    && row.products[1].name === 'Botanical Decor'
    && row.products[1].imageUrl === 'https://drive.example/highlight.webp',
    row.products);

  // ----------------------------------------------------------------
  // THE OLD ROWS. Generations recorded before the products were stored
  // have none. They must still appear -- a history that hides what it
  // cannot fully describe is worse than one that says so.
  // ----------------------------------------------------------------
  const old = generationRow({
    id: 'log-old',
    createdAt: '2026-10-26T02:18:00Z',
    user: null,
    metadata: { imageUrl: 'https://drive.example/old.webp', productName: 'Midnight Contrast' },
  }) as Record<string, any>;
  check('14. a row recorded before products existed still reads back',
    old.imageUrl === 'https://drive.example/old.webp' && old.productName === 'Midnight Contrast',
    old);
  check('15. ...and its base product code becomes a product entry',
    old.products.length === 1 && old.products[0].role === 'base'
    && old.products[0].code === 'Midnight Contrast', old.products);

  const noMeta = generationRow({ id: 'x', createdAt: '2026-01-01T00:00:00Z' }) as Record<string, any>;
  check('16. a row with no metadata at all does not throw',
    noMeta.imageUrl === '' && Array.isArray(noMeta.products) && noMeta.products.length === 0, noMeta);

  // A product entry that is not an object cannot reach the page as one.
  const junk = generationRow({
    id: 'x', createdAt: '2026-01-01T00:00:00Z',
    metadata: { products: ['not an object', null, 42, { name: 'Real Tile' }] },
  }) as Record<string, any>;
  check('17. junk in the stored product list is dropped, the real one kept',
    junk.products.length === 1 && junk.products[0].name === 'Real Tile', junk.products);

  const partial = generationRow({
    id: 'x', createdAt: '2026-01-01T00:00:00Z',
    metadata: { products: [{ name: 'Half Tile' }] },
  }) as Record<string, any>;
  check('18. a product with no image reads back as empty, never "undefined"',
    partial.products[0].imageUrl === '' && partial.products[0].code === ''
    && partial.products[0].role === '',
    partial.products[0]);

  // ----------------------------------------------------------------
  // THE PICTURE THE LOG DOES NOT HOLD.
  //
  // A product whose image was an inline data: URL is recorded without
  // one, so the card showed a name and a grey square. The code names a
  // real product, so the image is read back from the Tile row.
  // ----------------------------------------------------------------
  const known = new Map([
    ['URV-0014', { imageUrl: 'https://drive.example/URV-0014.webp' }],
    ['DEC-0002', { imageUrl: '/uploads/extracted-images/DEC-0002.webp' }],
  ]);

  const dropped = generationRow({
    id: 'log-d',
    createdAt: '2026-10-30T02:17:00Z',
    metadata: {
      products: [
        { role: 'base', name: 'Urvi Statuario', code: 'URV-0014', imageUrl: '' },
        { role: 'highlight', name: 'Botanical Decor', code: 'DEC-0002', imageUrl: '' },
      ],
    },
  }, known) as Record<string, any>;

  check('19. a product recorded without a picture gets one from its tile',
    dropped.products[0].imageUrl === 'https://drive.example/URV-0014.webp',
    dropped.products[0]);
  check('20. ...including a path that is relative to the backend',
    dropped.products[1].imageUrl === '/uploads/extracted-images/DEC-0002.webp',
    dropped.products[1]);
  check('21. ...and everything else about the product is untouched',
    dropped.products[0].name === 'Urvi Statuario'
    && dropped.products[0].role === 'base'
    && dropped.products[0].code === 'URV-0014', dropped.products[0]);

  const keptOwn = generationRow({
    id: 'log-k', createdAt: '2026-10-30T02:17:00Z',
    metadata: { products: [
      { role: 'base', name: 'N', code: 'URV-0014', imageUrl: 'https://stored/own.webp' },
    ] },
  }, known) as Record<string, any>;
  check('22. a product that recorded its own picture keeps it, not the tile\'s',
    keptOwn.products[0].imageUrl === 'https://stored/own.webp', keptOwn.products[0]);

  const unknownCode = generationRow({
    id: 'log-u', createdAt: '2026-10-30T02:17:00Z',
    metadata: { products: [{ role: 'base', name: 'Gone', code: 'GONE-0001', imageUrl: '' }] },
  }, known) as Record<string, any>;
  check('23. a code that matches no tile leaves the product named, with no image',
    unknownCode.products[0].name === 'Gone' && unknownCode.products[0].imageUrl === '',
    unknownCode.products[0]);

  check('24. no lookup at all still reads back cleanly',
    (generationRow({ id: 'x', createdAt: '2026-01-01T00:00:00Z',
      metadata: { products: [{ role: 'base', code: 'URV-0014' }] } }) as any)
      .products[0].imageUrl === '');

  // ----------------------------------------------------------------
  // THE DRIVE LINK A BROWSER CAN ACTUALLY RENDER.
  //
  // Tile.imageUrl carries Drive's webViewLink -- an HTML viewer PAGE.
  // An <img> pointed at it is handed a document instead of pixels and
  // shows a broken-image icon, which is what this card showed beside
  // every product name. The mood board's own tile lookup has always
  // normalised these; this did not.
  // ----------------------------------------------------------------
  const drive = generationRow({
    id: 'log-dr', createdAt: '2026-10-31T00:00:00Z',
    metadata: { products: [
      { role: 'base', name: 'A', code: 'C1',
        imageUrl: 'https://drive.google.com/file/d/1AbCdEf/view?usp=sharing' },
      { role: 'highlight', name: 'B', code: 'C2',
        imageUrl: 'https://drive.google.com/uc?export=download&id=9XyZ' },
      { role: 'accent', name: 'C', code: 'C3',
        imageUrl: '/uploads/extracted-images/x.webp' },
    ] },
  }) as Record<string, any>;

  check('25. a Drive viewer PAGE becomes a renderable thumbnail',
    drive.products[0].imageUrl === 'https://drive.google.com/thumbnail?id=1AbCdEf&sz=w1000',
    drive.products[0].imageUrl);
  check('26. ...and so does the download form, which also serves HTML',
    drive.products[1].imageUrl === 'https://drive.google.com/thumbnail?id=9XyZ&sz=w1000',
    drive.products[1].imageUrl);
  check('27. a path that is not Drive is left exactly as it is',
    drive.products[2].imageUrl === '/uploads/extracted-images/x.webp',
    drive.products[2].imageUrl);

  // A picture recovered from the tile row needs the same treatment --
  // it comes from the same column, in the same shape.
  const recovered = generationRow({
    id: 'log-rv', createdAt: '2026-10-31T00:00:00Z',
    metadata: { products: [{ role: 'base', name: 'A', code: 'URV-0014', imageUrl: '' }] },
  }, new Map([['URV-0014', { imageUrl: 'https://drive.google.com/file/d/ZZZ/view' }]])) as Record<string, any>;
  check('28. a picture recovered from the tile row is normalised too',
    recovered.products[0].imageUrl === 'https://drive.google.com/thumbnail?id=ZZZ&sz=w1000',
    recovered.products[0].imageUrl);

  const nothing = generationRow({
    id: 'log-n', createdAt: '2026-10-31T00:00:00Z',
    metadata: { products: [{ role: 'base', name: 'A', code: 'X', imageUrl: '' }] },
  }) as Record<string, any>;
  check('29. no picture anywhere still reads back as an empty string',
    nothing.products[0].imageUrl === '', nothing.products[0].imageUrl);

  // ----------------------------------------------------------------
  // A GENERATION FROM BEFORE THE COMBINATION WAS RECORDED.
  //
  // Those rows kept one product CODE and nothing else, so the card
  // printed the bare code in a sentence -- no product, no picture, and
  // no readable name. The code names a real catalog product.
  // ----------------------------------------------------------------
  const CODE = 'DME-ITACA-1200X2400-COLLECTION-1-0023';
  const catalog = new Map([[CODE, {
    imageUrl: 'https://drive.google.com/file/d/ABC/view',
    name: 'Travertine Vain Lait', size: '1200x2400mm', finish: 'Matt',
  }]]);

  const legacy = generationRow({
    id: 'log-l', createdAt: '2026-10-30T02:33:00Z',
    metadata: { imageUrl: 'https://x/s.webp', productName: CODE, room: 'Living Room' },
  }, catalog) as Record<string, any>;

  check('30. an old row becomes a real product, not a sentence',
    legacy.products.length === 1 && legacy.products[0].role === 'base',
    legacy.products);
  check('31. ...with the tile\'s readable name, not just its code',
    legacy.products[0].name === 'Travertine Vain Lait', legacy.products[0].name);
  check('32. ...its size and finish',
    legacy.products[0].size === '1200x2400mm' && legacy.products[0].finish === 'Matt',
    legacy.products[0]);
  check('33. ...and a picture a browser can actually render',
    legacy.products[0].imageUrl === 'https://drive.google.com/thumbnail?id=ABC&sz=w1000',
    legacy.products[0].imageUrl);
  check('34. ...flagged partial, so one tile is not shown as the whole board',
    legacy.productsPartial === true, legacy.productsPartial);

  const full = generationRow({
    id: 'log-f', createdAt: '2026-10-31T00:00:00Z',
    metadata: { productName: CODE, products: [
      { role: 'base', name: 'A', code: 'C1', imageUrl: 'https://x/a.webp' },
      { role: 'highlight', name: 'B', code: 'C2', imageUrl: 'https://x/b.webp' },
    ] },
  }, catalog) as Record<string, any>;
  check('35. a row that recorded its combination is not flagged partial',
    full.productsPartial === false && full.products.length === 2, full.productsPartial);

  const neither = generationRow({
    id: 'log-x', createdAt: '2026-10-30T02:33:00Z', metadata: { imageUrl: 'https://x/s.webp' },
  }, catalog) as Record<string, any>;
  check('36. a row with no product at all stays empty, and is not flagged',
    neither.products.length === 0 && neither.productsPartial === false, neither.products);

  const unknown = generationRow({
    id: 'log-g', createdAt: '2026-10-30T02:33:00Z', metadata: { productName: 'GONE-1' },
  }, catalog) as Record<string, any>;
  check('37. a code no tile matches still shows as a product, by its code',
    unknown.products.length === 1 && unknown.products[0].code === 'GONE-1'
    && unknown.products[0].imageUrl === '', unknown.products[0]);

  // ------------------------------------------------------------------
  // THE SCENE'S BYTES ARE NOT IN THE LIST
  //
  // A generated scene is kept as an inline data: URL -- 1.5-2.5MB of
  // base64 -- because Node and Python share no disk and it is the only
  // copy that survives. The history sent sixty of those in one response
  // and wrote every one into the page's HTML, which is the whole of why
  // Recent Generations took so long to open. The row carries a path now.
  // ------------------------------------------------------------------
  const inlineScene = generationRow({
    id: 'log-inline',
    createdAt: '2026-10-30T02:40:00Z',
    metadata: { imageUrl: 'data:image/png;base64,' + 'A'.repeat(200000), imageSource: 'inline' },
  }) as Record<string, any>;
  check('38. a scene kept as a data: URL is not sent in the row',
    inlineScene.imageUrl === '', String(inlineScene.imageUrl).slice(0, 40));
  check('39. ...and the row carries the path to it instead',
    inlineScene.imagePath === '/ai/visualizations/recent/log-inline/image', inlineScene.imagePath);
  check('40. ...and still says there IS a picture',
    inlineScene.hasImage === true, inlineScene.hasImage);

  const driveScene = generationRow({
    id: 'log-drive',
    createdAt: '2026-10-30T02:41:00Z',
    metadata: { imageUrl: 'https://drive.example/scene.webp', imageSource: 'drive' },
  }) as Record<string, any>;
  check('41. a Drive link is small, so it is still sent as a URL',
    driveScene.imageUrl === 'https://drive.example/scene.webp', driveScene.imageUrl);
  check('42. ...with no path, because the card loads it directly',
    driveScene.imagePath === '' && driveScene.hasImage === true, driveScene);

  const noScene = generationRow({
    id: 'log-none', createdAt: '2026-10-30T02:42:00Z', metadata: { imageSource: 'too-large' },
  }) as Record<string, any>;
  check('43. a generation whose picture was not kept has neither, and says so',
    noScene.imageUrl === '' && noScene.imagePath === '' && noScene.hasImage === false, noScene);

  // The endpoint that serves one of them.
  const decoded = decodeDataUrl('data:image/webp;base64,' + Buffer.from('tiny').toString('base64'));
  check('44. a data: URL decodes to its type and its bytes',
    decoded?.mime === 'image/webp' && decoded?.bytes.toString() === 'tiny', decoded?.mime);
  check('45. something that is not a data: URL is refused',
    decodeDataUrl('https://drive.example/scene.webp') === null);
  check('46. ...and so is a data: URL that is not an image',
    decodeDataUrl('data:text/html;base64,' + Buffer.from('<b>no</b>').toString('base64')) === null);
  check('47. ...and an empty payload is not served as an image',
    decodeDataUrl('data:image/png;base64,') === null);

  // ------------------------------------------------------------------
  // THE VERDICT IS KEPT WITH THE GENERATION
  //
  // Every scene is judged against its theme as it is generated, and the
  // mood board shows the finding once. Nothing kept it, so a board whose
  // floor was reported as missing its heritage pattern looked, a week
  // later, exactly like one that passed.
  // ------------------------------------------------------------------
  const verdict = generationVerdict({
    status: 'partial',
    theme: 'British',
    room: 'Bathroom',
    present: ['panelling', 'brass', 'a classic mirror'],
    partial: ['Heritage green and/or oxblood are meaningfully represented.'],
    missing: ['The flooring supports the heritage aesthetic.'],
  }) as Record<string, any>;
  check('48. the verdict is kept with the generation',
    verdict?.status === 'partial' && verdict?.theme === 'British' && verdict?.room === 'Bathroom',
    verdict);
  check('49. ...with the half a person can act on',
    verdict.missing.length === 1 && verdict.partial.length === 1, verdict);
  check('50. ...and not the reassuring half, which is not worth a database row',
    !('present' in verdict), Object.keys(verdict));

  const flood = generationVerdict({
    status: 'fail',
    missing: Array.from({ length: 40 }, (_, i) => `line ${i} `.repeat(200)),
  }) as Record<string, any>;
  check('51. a verdict is bounded, not trusted',
    flood.missing.length === 8 && flood.missing.every((l: string) => l.length <= 300),
    { lines: flood.missing.length, longest: Math.max(...flood.missing.map((l: string) => l.length)) });

  check('52. something that is not a verdict is not stored as one',
    generationVerdict(null) === null
    && generationVerdict('partial') === null
    && generationVerdict({ theme: 'British' }) === null);

  const unchecked = generationVerdict({
    status: 'unchecked', theme: 'British', reason: 'the check could not run: no key',
  }) as Record<string, any>;
  check('53. an unchecked verdict keeps the reason it was not checked',
    unchecked.status === 'unchecked' && /no key/.test(unchecked.reason), unchecked);

  const judged = generationRow({
    id: 'log-v', createdAt: '2026-11-02T12:00:00Z',
    metadata: {
      imageUrl: 'https://drive.example/s.webp',
      themeCheck: { status: 'fail', theme: 'British', missing: ['The flooring.'] },
    },
  }) as Record<string, any>;
  check('54. the row carries the verdict out to the page',
    judged.themeCheck?.status === 'fail' && judged.themeCheck.missing[0] === 'The flooring.',
    judged.themeCheck);

  const unjudged = generationRow({
    id: 'log-old', createdAt: '2026-10-30T02:33:00Z',
    metadata: { imageUrl: 'https://drive.example/old.webp' },
  }) as Record<string, any>;
  check('55. a generation from before the verdict was kept carries none',
    unjudged.themeCheck === null, unjudged.themeCheck);

  let failures = 0;
  for (const [label, ok, detail] of results) {
    if (ok) console.log(`  PASS  ${label}`);
    else { failures += 1; console.log(`  FAIL  ${label}${detail ? '  [' + detail + ']' : ''}`); }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  return failures ? 1 : 0;
}

process.exit(main());
