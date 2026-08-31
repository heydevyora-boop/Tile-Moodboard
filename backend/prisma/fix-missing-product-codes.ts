/* eslint-disable no-console */
// One-off repair script: assigns a productCode to any tile that's missing
// one. Tiles without a productCode can't be matched against the Google
// Sheet MASTER tab, so AI visualization rejects them with a 422 ("has no
// catalog product code set"). This happens to tiles created before the
// catalog extraction pipeline was fixed, or added through any path other
// than a full extraction run.
//
// Safe to run any time — it only ever sets productCode where it's
// currently null/empty, never touches tiles that already have one, and
// never deletes anything (deleting would cascade-delete MoodBoardTile
// rows via the schema's onDelete: Cascade, corrupting any mood board
// that already references the tile).
//
// Usage: npm run fix-product-codes
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not defined in the environment.');
}
const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

function sanitize(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'UNKNOWN';
}

async function main() {
  const tiles = await prisma.tile.findMany({
    where: { OR: [{ productCode: null }, { productCode: '' }] },
    include: { brand: { select: { name: true } } },
  });

  if (tiles.length === 0) {
    console.log('✅ No tiles are missing a product code. Nothing to do.');
    return;
  }

  console.log(`Found ${tiles.length} tile(s) missing a product code:\n`);

  for (const tile of tiles) {
    // MANUAL- prefix marks this as a repair-assigned code, not a real
    // catalog product code — it will not match anything in the Google
    // Sheet MASTER tab, so AI visualization will still be unable to find
    // real product data for it. This only unblocks the "no product code
    // set" validation error; re-extracting the tile's actual catalog is
    // the real fix for full AI visualization support.
    const code = `MANUAL-${sanitize(tile.brand.name)}-${sanitize(tile.name)}-${tile.id.slice(-6).toUpperCase()}`;

    await prisma.tile.update({
      where: { id: tile.id },
      data: { productCode: code },
    });

    console.log(`  ${tile.brand.name} — "${tile.name}" → ${code}`);
  }

  console.log(
    `\n✅ Assigned product codes to ${tiles.length} tile(s). ` +
      `Note: these are placeholder codes (MANUAL- prefix) — they unblock ` +
      `the validation error, but AI visualization still won't find real ` +
      `product data for these tiles until they're properly re-extracted.`,
  );
}

main()
  .catch((err) => {
    console.error('❌ Fix failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
