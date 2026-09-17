/**
 * Regression: the mood board's whole combination must reach Python.
 *
 * THE FAILURE THIS COVERS
 * -----------------------
 * A board selects BASE, HIGHLIGHT and ACCENT. The generated bathroom
 * showed only the base.
 *
 * The first fix threaded a `materials` list from the browser, through
 * the route, to the Python service -- and it STILL only rendered the
 * base, because generateVisualization builds the outgoing body field by
 * field. `materials` was not one of the named fields, so the route
 * resolved all three, handed them over, and they were dropped one layer
 * below, leaving product_id (the base) as the only material Python ever
 * saw. Nothing failed; the request simply left without them.
 *
 * That is the layer this test exists for. Asserting that a function
 * ACCEPTS a parameter proves nothing about whether it forwards it, so
 * this asserts on the actual HTTP body: fetch is stubbed and the JSON
 * that would have gone over the wire is read back.
 *
 * Run:  npx ts-node -r tsconfig-paths/register \
 *         test-scripts/visualization_materials_test.ts
 */

import { generateVisualization } from '../src/services/python-ai.service';

type Body = Record<string, any>;

let captured: Body | null = null;

const realFetch = global.fetch;

global.fetch = (async (_url: any, init: any) => {
  captured = JSON.parse(init.body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => ({ success: true, status: 'COMPLETED' }),
    text: async () => '{"success":true}',
  };
}) as any;

const results: Array<[string, boolean, string]> = [];

function check(label: string, ok: boolean, detail = '') {
  results.push([label, Boolean(ok), detail]);
}

async function send(materials?: any[]) {
  captured = null;
  await generateVisualization({
    product_id: 'BASE-CODE',
    surface: 'WALL',
    generate_random_scene: true,
    fallback_image_url: '/static/tiles/base.webp',
    materials: materials as any,
  });
  return captured as unknown as Body;
}

async function main() {
  // ----------------------------------------------------------------
  // A full combination must arrive intact.
  // ----------------------------------------------------------------
  const body = await send([
    {
      role: 'base',
      image_url: '/static/tiles/base.webp',
      product_id: 'BASE-CODE',
      name: 'Tile A',
    },
    {
      role: 'highlight',
      image_url: '/static/tiles/highlight.webp',
      product_id: 'HL-CODE',
      name: 'Tile B',
    },
    {
      role: 'accent',
      image_url: 'https://drive.google.com/accent.png',
      product_id: 'AC-CODE',
      name: 'Tile C',
    },
  ]);

  check(
    'the request body carries a materials list',
    Array.isArray(body.materials),
    `got ${typeof body.materials}`,
  );

  const materials: Body[] = body.materials || [];

  check(
    `all three materials are in the body (${materials.length})`,
    materials.length === 3,
  );

  check(
    'their roles survive, in order',
    JSON.stringify(materials.map((m) => m.role)) ===
      JSON.stringify(['base', 'highlight', 'accent']),
    JSON.stringify(materials.map((m) => m.role)),
  );

  check(
    'each carries its OWN image, not the base image three times',
    new Set(materials.map((m) => m.image_url)).size === 3,
    JSON.stringify(materials.map((m) => m.image_url)),
  );

  check(
    'each carries its own product code',
    JSON.stringify(materials.map((m) => m.product_id)) ===
      JSON.stringify(['BASE-CODE', 'HL-CODE', 'AC-CODE']),
    JSON.stringify(materials.map((m) => m.product_id)),
  );

  // A relative /static path is only meaningful to Express. Python runs
  // elsewhere, so a material sent as a bare path is a material Python
  // cannot download -- i.e. one that silently will not appear.
  check(
    'relative material images are made absolute for Python',
    materials
      .filter((m) => m.role !== 'accent')
      .every((m) => /^https?:\/\//i.test(m.image_url)),
    JSON.stringify(materials.map((m) => m.image_url)),
  );

  check(
    'an already-absolute image is left absolute',
    Boolean(materials[2]) &&
      /^https?:\/\//i.test(materials[2].image_url),
    materials[2]?.image_url ?? 'no third material in the body',
  );

  // ----------------------------------------------------------------
  // A material with no usable image must not become an empty promise.
  // ----------------------------------------------------------------
  const partial = await send([
    { role: 'base', image_url: '/static/tiles/base.webp' },
    { role: 'highlight', image_url: '' },
  ]);

  check(
    'a material with no image is dropped from the body',
    (partial.materials || []).length === 1,
    `${(partial.materials || []).length} sent`,
  );

  // ----------------------------------------------------------------
  // The single-tile path must be untouched.
  // ----------------------------------------------------------------
  const single = await send(undefined);

  check(
    'a request with no combination sends no materials field',
    single.materials === undefined,
    JSON.stringify(single.materials),
  );

  check(
    'and still sends the base product_id as before',
    single.product_id === 'BASE-CODE',
  );

  // ----------------------------------------------------------------
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

  global.fetch = realFetch;
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
