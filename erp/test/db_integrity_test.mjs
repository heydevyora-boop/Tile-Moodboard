import { prisma, disconnect } from '../db/client.mjs';
import {
  postStockMovement, reverseStockMovement, nextDocumentNumber,
  DuplicateMovementError, InsufficientStockError,
} from '../db/stock.mjs';

/**
 * EVERY GUARANTEE THE ARCHITECTURE CLAIMS, TESTED AGAINST THE REAL
 * DATABASE.
 *
 * A schema file can say "append-only" in a comment and a document
 * can repeat it. Neither proves the database refuses the UPDATE.
 * These checks make the claims falsifiable: each one tries the
 * thing that must not work and fails if it succeeds.
 *
 * Run:  node test/db_integrity_test.mjs
 */

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + String(extra).slice(0, 220)));
}

/** Runs `fn` and reports whether it threw, and with what. */
async function refused(fn) {
  try { await fn(); return { threw: false }; }
  catch (err) { return { threw: true, err }; }
}

async function main() {
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
  const product = await prisma.product.findUniqueOrThrow({ where: { sku: 'DV-1001' } });

  console.log('\n1. the database is the ERP\'s own, not the website\'s');

  const dbName = (await prisma.$queryRaw`SELECT current_database() AS n`)[0].n;
  check('1a. connected to a database named for the ERP', /erp/i.test(dbName), dbName);
  check('1b. it is reached through ERP_DATABASE_URL, which is set',
    typeof process.env.ERP_DATABASE_URL === 'string' && process.env.ERP_DATABASE_URL.length > 0);

  /* The website's schema and the ERP's must have nothing in common.
     If a website table turned up here, the two had been pointed at
     one database -- the single worst outcome this design guards
     against, and the one that would be easiest to miss. */
  const websiteTables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('tiles', 'brands_website', 'mood_boards', 'catalogs',
                         'customer_favorites', 'library_images', 'client_wishlists')
  `;
  check('1c. not one Casa De Aurum website table is present',
    websiteTables.length === 0, websiteTables.map((t) => t.table_name));

  console.log('\n2. the stock ledger is append-only, enforced by the database');

  const entry = await prisma.stockLedgerEntry.findFirstOrThrow({
    where: { productId: product.id },
  });

  const update = await refused(() => prisma.$executeRaw`
    UPDATE "stock_ledger_entries" SET "quantity" = 9999 WHERE "id" = ${entry.id}::uuid
  `);
  check('2a. an UPDATE of a ledger entry is refused', update.threw,
    update.threw ? update.err.message : 'it succeeded');

  const del = await refused(() => prisma.$executeRaw`
    DELETE FROM "stock_ledger_entries" WHERE "id" = ${entry.id}::uuid
  `);
  check('2b. a DELETE of a ledger entry is refused', del.threw,
    del.threw ? del.err.message : 'it succeeded');

  // TRUNCATE bypasses row triggers, so it needs its own guard; a
  // statement-level trigger is the only thing that stops it.
  const trunc = await refused(() => prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "stock_ledger_entries"',
  ));
  check('2c. a TRUNCATE of the whole ledger is refused', trunc.threw,
    trunc.threw ? trunc.err.message : 'IT SUCCEEDED — the history is gone');

  const stillThere = await prisma.stockLedgerEntry.findUnique({ where: { id: entry.id } });
  check('2d. ...and the entry is untouched after all three attempts',
    stillThere !== null && String(stillThere.quantity) === String(entry.quantity));

  const auditUpdate = await refused(() => prisma.$executeRawUnsafe(
    `UPDATE "audit_logs" SET "summary" = 'x' WHERE true`,
  ));
  // With no audit rows yet the UPDATE touches nothing and the row
  // trigger never fires, so this is asserted on the trigger itself.
  const auditTriggers = await prisma.$queryRaw`
    SELECT tgname FROM pg_trigger
    WHERE NOT tgisinternal AND tgrelid = '"audit_logs"'::regclass
  `;
  check('2e. the audit log carries the same three guards',
    auditTriggers.length === 3, auditTriggers.map((t) => t.tgname));

  console.log('\n3. a correction adds a row, it never changes one');

  const before = await prisma.stockLedgerEntry.count({ where: { productId: product.id } });
  const sample = await postStockMovement({
    productId: product.id,
    warehouseId: warehouse.id,
    movementType: 'OUTWARD',
    reason: 'SAMPLE_ISSUE',
    quantity: 2,
    uom: 'BOX',
    referenceType: 'MANUAL',
    idempotencyKey: 'test:sample:' + Date.now(),
    createdById: admin.id,
  });

  const reversal = await reverseStockMovement({ entryId: sample.id, createdById: admin.id });
  const after = await prisma.stockLedgerEntry.count({ where: { productId: product.id } });

  check('3a. reversing a movement ADDS an entry rather than removing one',
    after === before + 2, { before, after });
  check('3b. the reversal points back at what it corrects',
    reversal.reversalOfEntryId === sample.id);
  check('3c. the original is still there, unchanged',
    (await prisma.stockLedgerEntry.findUnique({ where: { id: sample.id } })) !== null);
  check('3d. ...and the two cancel out exactly',
    Number(reversal.balanceAfter) === Number(sample.balanceAfter) + 2,
    { sample: String(sample.balanceAfter), reversal: String(reversal.balanceAfter) });

  const doubleReverse = await refused(() => reverseStockMovement({
    entryId: sample.id, createdById: admin.id,
  }));
  check('3e. reversing the same entry twice is refused',
    doubleReverse.threw && doubleReverse.err instanceof DuplicateMovementError);

  console.log('\n4. the same movement cannot be posted twice');

  const key = 'test:idempotency:' + Date.now();
  const move = {
    productId: product.id,
    warehouseId: warehouse.id,
    movementType: 'OUTWARD',
    reason: 'SALES_DISPATCH',
    quantity: 3,
    uom: 'BOX',
    referenceType: 'MANUAL',
    idempotencyKey: key,
    createdById: admin.id,
  };

  const first = await postStockMovement(move);
  const second = await refused(() => postStockMovement(move));
  check('4a. a repeated post is rejected, not applied twice',
    second.threw && second.err instanceof DuplicateMovementError);

  const balanceNow = await prisma.inventoryBalance.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: product.id, warehouseId: warehouse.id } },
  });
  check('4b. ...and the stock moved exactly once',
    Number(balanceNow.quantityOnHand) === Number(first.balanceAfter),
    { balance: String(balanceNow.quantityOnHand), afterFirst: String(first.balanceAfter) });

  console.log('\n5. stock cannot go negative');

  const tooMuch = await refused(() => postStockMovement({
    ...move,
    quantity: 100000,
    idempotencyKey: 'test:overdraw:' + Date.now(),
  }));
  check('5a. a dispatch larger than the balance is refused',
    tooMuch.threw && tooMuch.err instanceof InsufficientStockError,
    tooMuch.threw ? tooMuch.err.message : 'it succeeded');

  // And again at the database level, for anything that bypasses the
  // helper entirely.
  const rawNegative = await refused(() => prisma.$executeRaw`
    UPDATE "inventory_balances" SET "quantityOnHand" = -5
    WHERE "productId" = ${product.id}::uuid AND "warehouseId" = ${warehouse.id}::uuid
  `);
  check('5b. a negative balance written directly is refused by the database',
    rawNegative.threw, rawNegative.threw ? 'CHECK constraint held' : 'it succeeded');

  const zeroQty = await refused(() => prisma.$executeRawUnsafe(`
    INSERT INTO "stock_ledger_entries"
      ("id","productId","warehouseId","movementType","reason","quantity","uom",
       "balanceAfter","referenceType","transactionDate","idempotencyKey","createdById")
    VALUES (gen_random_uuid(), '${product.id}', '${warehouse.id}', 'OUTWARD','DAMAGE',
            0, 'BOX', 0, 'MANUAL', now(), 'test:zero:${Date.now()}', '${admin.id}')
  `));
  check('5c. a movement of zero boxes is refused', zeroQty.threw);

  console.log('\n6. concurrent movements of the same product do not race');

  /* THE LOST UPDATE. Without the row lock in postStockMovement,
     ten simultaneous dispatches each read the same starting
     balance and each write their own result: the last writer wins
     and nine boxes vanish, with ten perfectly plausible ledger
     entries and no way to tell afterwards which was wrong.
     Fired together on purpose. */
  const racer = await prisma.product.findUniqueOrThrow({ where: { sku: 'DV-1007' } });
  const startBalance = Number((await prisma.inventoryBalance.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: racer.id, warehouseId: warehouse.id } },
  })).quantityOnHand);

  const stamp = Date.now();
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => postStockMovement({
      productId: racer.id,
      warehouseId: warehouse.id,
      movementType: 'OUTWARD',
      reason: 'SALES_DISPATCH',
      quantity: 1,
      uom: 'BOX',
      referenceType: 'MANUAL',
      idempotencyKey: 'test:race:' + stamp + ':' + i,
      createdById: admin.id,
    })),
  );

  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const endBalance = Number((await prisma.inventoryBalance.findUniqueOrThrow({
    where: { productId_warehouseId: { productId: racer.id, warehouseId: warehouse.id } },
  })).quantityOnHand);

  check('6a. all ten concurrent dispatches were applied', ok === 10, ok);
  check('6b. the balance fell by exactly ten, not fewer',
    endBalance === startBalance - 10, { startBalance, endBalance });

  const balancesAfter = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => Number(r.value.balanceAfter))
    .sort((a, b) => b - a);
  check('6c. every entry recorded a distinct running balance',
    new Set(balancesAfter).size === 10, balancesAfter);

  console.log('\n7. the balance agrees with the ledger that produced it');

  const drifted = await prisma.$queryRaw`
    SELECT "sku", projected_quantity::text AS projected, ledger_quantity::text AS ledger
    FROM v_inventory_reconciliation WHERE NOT reconciled
  `;
  check('7a. not one balance has drifted from its own history',
    drifted.length === 0, drifted);

  const counted = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM v_inventory_reconciliation
  `;
  check('7b. ...and the view actually looked at something',
    counted[0].n > 0, counted[0].n);

  console.log('\n8. availability is derived, never stored on the product');

  const columns = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'products'
      AND (column_name ILIKE '%stock%' OR column_name ILIKE '%onhand%'
           OR column_name ILIKE '%quantity%' OR column_name ILIKE '%available%')
  `;
  check('8a. the Product Master holds no quantity column at all',
    columns.length === 0, columns.map((c) => c.column_name));

  const statuses = await prisma.$queryRaw`
    SELECT unnest(enum_range(NULL::"ProductStatus"))::text AS v
  `;
  check('8b. ProductStatus is exactly ACTIVE, INACTIVE, DISCONTINUED',
    statuses.map((s) => s.v).sort().join(',') === 'ACTIVE,DISCONTINUED,INACTIVE',
    statuses.map((s) => s.v));

  const availability = await prisma.$queryRaw`
    SELECT availability, COUNT(*)::int AS n
    FROM v_product_availability GROUP BY availability ORDER BY availability
  `;
  const kinds = Object.fromEntries(availability.map((a) => [a.availability, a.n]));
  check('8c. out of stock is derived and reported for an ACTIVE product',
    (kinds.OUT_OF_STOCK || 0) > 0, kinds);
  /* THE TRAP THIS EXISTS FOR: a product that is both retired AND
     holding nothing. "No stock" is true of it, but calling it out
     of stock tells a buyer to reorder something the studio has
     decided to stop selling. The view must say DISCONTINUED.
     An earlier version of this check compared the two COUNTS and
     passed or failed on whether they happened to differ, which
     tested nothing about the behaviour. */
  const retiredEmpty = await prisma.product.upsert({
    where: { sku: 'TEST-RETIRED-EMPTY' },
    update: { status: 'DISCONTINUED' },
    create: {
      sku: 'TEST-RETIRED-EMPTY',
      name: 'Retired, nothing left',
      brandId: product.brandId,
      categoryId: product.categoryId,
      size: '600x600mm',
      purchasePrice: 10,
      sellingPrice: 20,
      status: 'DISCONTINUED',
    },
  });
  const retiredEmptyRow = await prisma.$queryRaw`
    SELECT availability, quantity_on_hand::text AS qty
    FROM v_product_availability WHERE product_id = ${retiredEmpty.id}::uuid
  `;
  check('8d. a retired product holding NOTHING still reads DISCONTINUED, not OUT_OF_STOCK',
    retiredEmptyRow[0].availability === 'DISCONTINUED' && Number(retiredEmptyRow[0].qty) === 0,
    retiredEmptyRow[0]);
  check('8d2. ...while an ACTIVE product holding nothing does read OUT_OF_STOCK',
    (kinds.OUT_OF_STOCK || 0) > 0 && (kinds.DISCONTINUED || 0) > 0, kinds);

  /* The fixture goes away again. It has no stock history, so it
     CAN be deleted -- and leaving it behind put a test row in the
     development catalogue, where it turned up in the Product
     Master as a real product priced at twenty rupees. A suite that
     litters the database it tests is a suite people stop running. */
  await prisma.product.delete({ where: { id: retiredEmpty.id } });

  const retired = await prisma.$queryRaw`
    SELECT sku, quantity_on_hand::text AS qty, availability
    FROM v_product_availability WHERE "status" = 'DISCONTINUED'
  `;
  check('8e. a retired product still holding stock reads as DISCONTINUED, not OUT_OF_STOCK',
    retired.every((r) => r.availability === 'DISCONTINUED'), retired);

  console.log('\n9. history cannot be deleted out from under itself');

  const delProduct = await refused(() => prisma.product.delete({ where: { id: product.id } }));
  check('9a. a product with stock movements cannot be deleted', delProduct.threw);

  const delBrand = await refused(() => prisma.brand.delete({
    where: { id: product.brandId },
  }));
  check('9b. a brand with products cannot be deleted', delBrand.threw);

  const delWarehouse = await refused(() => prisma.warehouse.delete({ where: { id: warehouse.id } }));
  check('9c. a warehouse with stock cannot be deleted', delWarehouse.threw);

  const delUser = await refused(() => prisma.user.delete({ where: { id: admin.id } }));
  check('9d. a user who posted a movement cannot be deleted', delUser.threw);

  /* The one place cascade is correct: a document and its own lines.
     Proven on a throwaway draft so the seeded data is untouched. */
  const supplier = await prisma.supplier.findFirstOrThrow();
  const draft = await prisma.purchaseOrder.create({
    data: {
      orderNo: 'TEST-PO-' + Date.now(),
      supplierId: supplier.id,
      warehouseId: warehouse.id,
      orderDate: new Date(),
      createdById: admin.id,
      lines: {
        create: [{
          lineNo: 1,
          productId: product.id,
          skuAtOrder: product.sku,
          nameAtOrder: product.name,
          quantity: 10,
          uom: 'BOX',
          unitPrice: product.purchasePrice,
          lineTotal: 100,
        }],
      },
    },
  });
  await prisma.purchaseOrder.delete({ where: { id: draft.id } });
  check('9e. deleting a draft document takes its own lines with it',
    (await prisma.purchaseOrderLine.count({ where: { purchaseOrderId: draft.id } })) === 0);

  console.log('\n10. identifiers, types and website preparation');

  const dupSku = await refused(() => prisma.product.create({
    data: {
      sku: 'DV-1001',
      name: 'Duplicate',
      brandId: product.brandId,
      categoryId: product.categoryId,
      size: '600x600mm',
      purchasePrice: 1,
      sellingPrice: 2,
    },
  }));
  check('10a. SKU uniqueness is enforced', dupSku.threw);

  const types = await prisma.$queryRaw`
    SELECT column_name, data_type, numeric_precision, numeric_scale
    FROM information_schema.columns
    WHERE table_name IN ('products', 'stock_ledger_entries', 'inventory_balances')
      AND column_name IN ('purchasePrice', 'sellingPrice', 'quantity', 'quantityOnHand', 'balanceAfter')
  `;
  check('10b. every price and quantity is numeric, never a float',
    types.length > 0 && types.every((t) => t.data_type === 'numeric'),
    types.map((t) => t.column_name + ':' + t.data_type));

  const idTypes = await prisma.$queryRaw`
    SELECT data_type FROM information_schema.columns
    WHERE table_name = 'products' AND column_name = 'id'
  `;
  check('10c. the permanent product id is a uuid', idTypes[0].data_type === 'uuid');

  /* Scoped to the seeded catalogue. This suite creates fixtures of
     its own (TEST-RETIRED-EMPTY above), and counting those would
     make the check fail for a reason that says nothing about the
     seed -- which is what it is actually asserting. */
  const seededSkus = await prisma.product.findMany({
    where: { sku: { startsWith: 'DV-' } },
    select: { id: true },
  });
  const mappings = await prisma.websiteProductMapping.findMany({
    where: { productId: { in: seededSkus.map((p) => p.id) } },
  });
  check('10d. every seeded product has a website mapping row',
    mappings.length === seededSkus.length,
    { products: seededSkus.length, mappings: mappings.length });
  check('10e. ...and not one of them is synced or carries an external id',
    mappings.every((m) => m.syncStatus === 'NOT_SYNCED'
      && m.externalProductId === null && m.lastSyncedAt === null));

  const seq1 = await nextDocumentNumber('SALES_ORDER');
  const seq2 = await nextDocumentNumber('SALES_ORDER');
  check('10f. document numbers do not repeat', seq1 !== seq2, [seq1, seq2]);

  const twoDefaults = await refused(() => prisma.warehouse.create({
    data: { code: 'WH-TEST-' + Date.now(), name: 'Second default', isDefault: true },
  }));
  check('10g. a second default warehouse is refused', twoDefaults.threw);

  console.log('\n' + passed + '/' + (passed + failures.length) + ' checks passed');
  if (failures.length) {
    console.log('failed:\n  ' + failures.join('\n  '));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => { console.error('\nSuite crashed:', err); process.exitCode = 1; })
  .finally(disconnect);
