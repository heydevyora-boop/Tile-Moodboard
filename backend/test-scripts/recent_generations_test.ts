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

  let failures = 0;
  for (const [label, ok, detail] of results) {
    if (ok) console.log(`  PASS  ${label}`);
    else { failures += 1; console.log(`  FAIL  ${label}${detail ? '  [' + detail + ']' : ''}`); }
  }
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  return failures ? 1 : 0;
}

process.exit(main());
