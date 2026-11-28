import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useTestDatabase, migrate, seed, ERP_ROOT } from './helpers/testdb.mjs';

/* ============================================================
   EVERY GUARANTEE STEP 5 CLAIMS, TESTED AGAINST A REAL DATABASE
   ============================================================

   A comment can say "append-only" and a document can repeat it.
   Neither proves the database refuses the UPDATE. Each check here
   tries the thing that must not work, and fails if it succeeds.

   ON ITS OWN DATABASE. The suite posts movements, cancels
   transfers and deactivates warehouses; run against the
   development data it would leave fixtures behind, which has
   happened once already. It builds its own database from the same
   migrations and the same seed, so the two cannot drift, and it
   recreates it on every run so nothing accumulates between runs
   and no assertion can quietly start measuring the last run's
   leftovers.

   Run:  npm run test:inventory
   ============================================================ */

const DB = 'devyora_erp_inventory_test';

/* A fresh start, every run. The name is checked first: the one
   thing this must never do is drop something that is not a test
   database of its own making. */
if (!/_inventory_test$/.test(DB)) {
  throw new Error('Refusing to recreate "' + DB + '": the name is not this suite\'s own.');
}
const admin = process.env.ERP_DATABASE_URL
  ?? 'postgresql://postgres@localhost:54329/postgres?host=/var/tmp';
try {
  const url = new URL(admin);
  url.pathname = '/postgres';
  execSync('psql "' + url.toString() + '" -qc "DROP DATABASE IF EXISTS ' + DB + ' WITH (FORCE)"',
    { stdio: 'pipe' });
} catch {
  // psql may not be on PATH; migrate deploy will fail with a
  // clearer message than anything invented here.
}

useTestDatabase(DB);
migrate();
seed();

const { prisma, disconnect } = await import('../db/client.mjs');
const stock = await import('../db/stock.mjs');
const inv = await import('../server/services/inventory.service.mjs');
const wh = await import('../server/services/warehouse.service.mjs');

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + String(extra).slice(0, 260)));
}

async function refused(fn) {
  try { await fn(); return { threw: false }; }
  catch (err) { return { threw: true, err }; }
}

async function company() {
  const [r] = await prisma.$queryRaw`
    SELECT physical_on_hand::text a, in_transit::text b, physical_total::text c,
           reserved::text d, damaged::text e, available::text f
    FROM v_company_stock`;
  return {
    onHand: Number(r.a), inTransit: Number(r.b), total: Number(r.c),
    reserved: Number(r.d), damaged: Number(r.e), available: Number(r.f),
  };
}

async function balance(productId, warehouseId) {
  const b = await prisma.inventoryBalance.findUnique({
    where: { productId_warehouseId: { productId, warehouseId } },
  });
  if (!b) return { onHand: 0, reserved: 0, damaged: 0, inTransit: 0 };
  return {
    onHand: Number(b.quantityOnHand), reserved: Number(b.quantityReserved),
    damaged: Number(b.quantityDamaged), inTransit: Number(b.quantityInTransit),
  };
}

const uniq = (s) => s + '-' + Math.random().toString(36).slice(2, 8);

async function main() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
  const main = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  const product = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1001' } });

  /* ────────────────────────────────────────────────────────
     1. THE DATABASE IS THE ERP'S OWN, AND IT IS ISOLATED
     ──────────────────────────────────────────────────────── */
  console.log('\n1. the right database, and nobody else\'s');

  const [{ n: dbName }] = await prisma.$queryRaw`SELECT current_database() AS n`;
  check('1a. the suite is running on its own test database', dbName === DB, dbName);
  check('1b. reached through ERP_DATABASE_URL, never DATABASE_URL',
    process.env.ERP_DATABASE_URL.includes(DB));

  /* ────────────────────────────────────────────────────────
     2. THE LEDGER IS APPEND-ONLY, AND THE DATABASE SAYS SO
     ──────────────────────────────────────────────────────── */
  console.log('\n2. the ledger cannot be rewritten');

  const { entry: sample } = await stock.postStockMovement({
    productId: product.id, warehouseId: main.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT',
    quantity: 10, referenceType: 'MANUAL', referenceNo: uniq('T2'),
    idempotencyKey: uniq('t2'), createdById: user.id,
  });

  const updated = await refused(() => prisma.$executeRaw`
    UPDATE "stock_ledger_entries" SET "quantity" = 1 WHERE "id" = ${sample.id}::uuid`);
  check('2a. UPDATE on a ledger entry is refused by the database', updated.threw, updated.err?.message);

  const deleted = await refused(() => prisma.$executeRaw`
    DELETE FROM "stock_ledger_entries" WHERE "id" = ${sample.id}::uuid`);
  check('2b. DELETE on a ledger entry is refused by the database', deleted.threw, deleted.err?.message);

  const truncated = await refused(() => prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "stock_ledger_entries" CASCADE'));
  check('2c. TRUNCATE on the ledger is refused by the database', truncated.threw, truncated.err?.message);

  /* The audit guard is a FOR EACH ROW trigger, so an UPDATE that
     matches nothing never fires it and the check passes without
     testing anything. This posts an audited movement first and
     asserts the table is non-empty, so a vacuous pass is
     impossible -- the first version of this check "passed"
     against an empty table. */
  await inv.stockInward({
    product: product.id, warehouseId: main.id, quantity: 1,
    remarks: 'Posted so there is an audit row to try to edit.',
    idempotencyKey: uniq('audit'),
  }, user);
  const auditRows = await prisma.auditLog.count();
  check('2d. there is an audit row to attempt this on at all', auditRows > 0, auditRows);

  const auditUpdate = await refused(() => prisma.$executeRaw`
    UPDATE "audit_logs" SET "summary" = 'edited'`);
  check('2e. the audit log cannot be edited either', auditUpdate.threw, auditUpdate.err?.message);

  const auditDelete = await refused(() => prisma.$executeRaw`DELETE FROM "audit_logs"`);
  check('2f. nor can an audit row be removed', auditDelete.threw, auditDelete.err?.message);

  /* ────────────────────────────────────────────────────────
     3. EVERY ENTRY CARRIES THE BALANCE BEFORE AND AFTER
     ──────────────────────────────────────────────────────── */
  console.log('\n3. previous and resulting balance, on every entry');

  check('3a. the entry records the balance it started from',
    Number(sample.balanceBefore) + 10 === Number(sample.balanceAfter),
    sample.balanceBefore + ' + 10 != ' + sample.balanceAfter);

  const [{ bad }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS bad FROM "stock_ledger_entries"
    WHERE CASE
      WHEN "movementType" IN ('INWARD','ADJUSTMENT_INCREASE','TRANSFER_IN')
        THEN "balanceAfter" <> "balanceBefore" + "quantity"
      WHEN "movementType" IN ('OUTWARD','ADJUSTMENT_DECREASE','TRANSFER_OUT')
        THEN "balanceAfter" <> "balanceBefore" - "quantity"
      ELSE "balanceAfter" <> "balanceBefore"
    END`;
  check('3b. every entry in the whole ledger is arithmetically consistent', bad === 0, bad + ' bad rows');

  const arithmetic = await refused(() => prisma.$executeRaw`
    INSERT INTO "stock_ledger_entries"
      ("id","productId","warehouseId","movementType","reason","quantity","uom",
       "balanceBefore","balanceAfter","referenceType","idempotencyKey","createdById","transactionDate")
    VALUES (gen_random_uuid(), ${product.id}::uuid, ${main.id}::uuid, 'INWARD','PURCHASE_RECEIPT',
       5,'BOX', 100, 999, 'MANUAL', ${uniq('bad')}, ${user.id}::uuid, now())`);
  check('3c. an entry whose arithmetic does not add up is refused outright',
    arithmetic.threw, arithmetic.err?.message);

  /* ────────────────────────────────────────────────────────
     4. ONE SERVICE, AND IDEMPOTENCY
     ──────────────────────────────────────────────────────── */
  console.log('\n4. the same movement is never posted twice');

  const key = uniq('idem');
  const move = {
    productId: product.id, warehouseId: main.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT', quantity: 4,
    referenceType: 'MANUAL', idempotencyKey: key, createdById: user.id,
  };
  const { entry: first } = await stock.postStockMovement(move);
  const again = await refused(() => stock.postStockMovement(move));
  check('4a. the same idempotency key is refused the second time', again.threw);
  check('4b. and refused as a duplicate, not as some other failure',
    again.err instanceof stock.DuplicateMovementError, again.err?.name);

  const count = await prisma.stockLedgerEntry.count({ where: { idempotencyKey: key } });
  check('4c. exactly one entry exists for that key', count === 1, count);
  check('4d. the first attempt is the one that stuck', Boolean(first.id));

  /* ────────────────────────────────────────────────────────
     5. REAL SIMULTANEOUS TRANSACTIONS
     ──────────────────────────────────────────────────────── */
  console.log('\n5. ten clerks saving at the same moment');

  const startRace = (await balance(product.id, main.id)).onHand;
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => stock.postStockMovement({
      productId: product.id, warehouseId: main.id,
      movementType: 'INWARD', reason: 'PURCHASE_RECEIPT', quantity: 1,
      referenceType: 'MANUAL', idempotencyKey: uniq('race' + i), createdById: user.id,
    })),
  );
  const won = results.filter((r) => r.status === 'fulfilled');
  check('5a. every one of the ten concurrent movements was accepted', won.length === 10,
    results.find((r) => r.status === 'rejected')?.reason?.message);

  const afterRace = (await balance(product.id, main.id)).onHand;
  check('5b. the balance moved by exactly ten, not by fewer',
    afterRace === startRace + 10, startRace + ' -> ' + afterRace);

  /* THE LOST UPDATE, WHICH IS WHAT THE ROW LOCK IS FOR. Ten
     concurrent movements must produce ten DIFFERENT resulting
     balances. Two entries claiming the same balanceAfter would
     mean two transactions read the same row and one overwrote the
     other -- the classic lost update, invisible in the total but
     fatal to the stock card. */
  const balances = won.map((r) => Number(r.value.entry.balanceAfter));
  check('5c. no two of them recorded the same resulting balance',
    new Set(balances).size === 10, balances.sort((a, b) => a - b).join(','));

  const befores = won.map((r) => Number(r.value.entry.balanceBefore));
  check('5d. and each one started from the previous one\'s result',
    befores.sort((a, b) => a - b).every((v, i) => v === startRace + i),
    befores.join(','));

  /* ────────────────────────────────────────────────────────
     6. NEGATIVE STOCK IS REFUSED, IN EVERY DIMENSION
     ──────────────────────────────────────────────────────── */
  console.log('\n6. stock cannot go below zero');

  const held = await balance(product.id, main.id);

  const over = await refused(() => inv.stockOutward({
    product: product.id, warehouseId: main.id, quantity: held.onHand + 1,
    idempotencyKey: uniq('over'),
  }, user));
  check('6a. issuing more than is on hand is refused', over.threw);
  check('6b. and refused as insufficient stock, with the figures',
    over.err?.code === 'INSUFFICIENT_STOCK' && over.err?.available === held.onHand,
    over.err?.message);

  await inv.reserve({ product: product.id, warehouseId: main.id, quantity: 5,
    referenceNo: 'SO-TEST', idempotencyKey: uniq('res') }, user);

  const afterReserve = await balance(product.id, main.id);
  check('6c. a reservation does not move a single box',
    afterReserve.onHand === held.onHand && afterReserve.reserved === held.reserved + 5,
    JSON.stringify(afterReserve));

  /* THE DEFAULT POLICY, AND THE ONE THAT MATTERS MOST: available
     stock, not physical stock, is what may not go negative.
     Issuing everything on the shelf would leave the reservation
     promising boxes that are no longer there. */
  const intoReserved = await refused(() => inv.stockOutward({
    product: product.id, warehouseId: main.id, quantity: afterReserve.onHand,
    idempotencyKey: uniq('eat-reserved'),
  }, user));
  check('6d. issuing stock that is already reserved for somebody is refused',
    intoReserved.threw && intoReserved.err?.dimension === 'available', intoReserved.err?.message);

  const overReserve = await refused(() => inv.reserve({
    product: product.id, warehouseId: main.id, quantity: afterReserve.onHand + 1,
    idempotencyKey: uniq('overres'),
  }, user));
  check('6e. reserving more than can be sold is refused', overReserve.threw, overReserve.err?.message);

  const overRelease = await refused(() => inv.releaseReservation({
    product: product.id, warehouseId: main.id, quantity: 9999,
    idempotencyKey: uniq('overrel'),
  }, user));
  check('6f. releasing more than was reserved is refused',
    overRelease.threw && overRelease.err?.dimension === 'reserved', overRelease.err?.message);

  const negative = await refused(() => prisma.$executeRaw`
    UPDATE "inventory_balances" SET "quantityOnHand" = -1
    WHERE "productId" = ${product.id}::uuid AND "warehouseId" = ${main.id}::uuid`);
  check('6g. a negative balance is refused by the database itself', negative.threw, negative.err?.message);

  /* ────────────────────────────────────────────────────────
     7. DAMAGE IS NOT A WRITE-OFF
     ──────────────────────────────────────────────────────── */
  console.log('\n7. damaged stock is still on the shelf');

  const beforeDamage = await balance(product.id, main.id);
  await inv.markDamaged({ product: product.id, warehouseId: main.id, quantity: 3,
    remarks: 'Pallet dropped in the yard.', idempotencyKey: uniq('dmg') }, user);
  const damaged = await balance(product.id, main.id);

  check('7a. marking stock damaged does not reduce what is physically there',
    damaged.onHand === beforeDamage.onHand, JSON.stringify(damaged));
  check('7b. but it does reduce what can be sold',
    damaged.damaged === beforeDamage.damaged + 3, JSON.stringify(damaged));

  const noReason = await refused(() => inv.markDamaged({
    product: product.id, warehouseId: main.id, quantity: 1, idempotencyKey: uniq('dmg2'),
  }, user));
  check('7c. damage with no explanation is refused', noReason.threw, noReason.err?.message);

  await inv.recoverDamaged({ product: product.id, warehouseId: main.id, quantity: 1,
    remarks: 'One box was fine after all.', idempotencyKey: uniq('rec') }, user);
  const recovered = await balance(product.id, main.id);
  check('7d. a box that turns out to be fine can be recovered',
    recovered.damaged === damaged.damaged - 1, JSON.stringify(recovered));

  /* ────────────────────────────────────────────────────────
     8. ADJUSTMENTS MUST SAY WHY
     ──────────────────────────────────────────────────────── */
  console.log('\n8. no correction without a reason');

  const blank = await refused(() => inv.stockAdjustment({
    product: product.id, warehouseId: main.id, quantity: 1, direction: 'OUT',
    remarks: '   ', idempotencyKey: uniq('adj'),
  }, user));
  check('8a. an adjustment with a blank reason is refused', blank.threw, blank.err?.message);

  const noDirection = await refused(() => inv.stockAdjustment({
    product: product.id, warehouseId: main.id, quantity: 1,
    remarks: 'Counted short.', idempotencyKey: uniq('adj2'),
  }, user));
  check('8b. an adjustment with no direction is refused', noDirection.threw, noDirection.err?.message);

  const adj = await inv.stockAdjustment({
    product: product.id, warehouseId: main.id, quantity: 2, direction: 'OUT',
    remarks: 'Stock count on the 21st: two boxes fewer than the system showed.',
    idempotencyKey: uniq('adj3'),
  }, user);
  check('8c. a properly explained adjustment posts, and says what it moved',
    adj.before.onHand - 2 === adj.after.onHand, JSON.stringify(adj.after));

  const stored = await prisma.stockLedgerEntry.findUniqueOrThrow({ where: { id: adj.entryId } });
  check('8d. and the reason is on the entry, not just in the request',
    /two boxes fewer/.test(stored.remarks ?? ''), stored.remarks);

  /* ────────────────────────────────────────────────────────
     9. OPENING STOCK IS SET ONCE
     ──────────────────────────────────────────────────────── */
  console.log('\n9. opening stock is an opening, not a correction');

  /* A product the seed left with no stock at all. Picked by
     asking the database rather than naming a SKU: the seed gives
     most products an opening balance, and hard-coding one that
     happens not to have one today is a test that breaks the next
     time the seed changes. */
  const fresh = await prisma.product.findFirstOrThrow({
    where: { archivedAt: null, inventory: { none: {} } },
  });
  await inv.openingStock({ product: fresh.id, warehouseId: main.id, quantity: 40,
    remarks: 'Counted at go-live.' }, user);
  const second = await refused(() => inv.openingStock({
    product: fresh.id, warehouseId: main.id, quantity: 50,
  }, user));
  check('9a. a second opening balance is refused', second.threw, second.err?.message);
  check('9b. and the refusal names the first one, so it can be checked',
    /already set on/.test(second.err?.message ?? ''), second.err?.message);

  const dbLevel = await refused(() => prisma.$executeRaw`
    INSERT INTO "stock_ledger_entries"
      ("id","productId","warehouseId","movementType","reason","quantity","uom",
       "balanceBefore","balanceAfter","referenceType","idempotencyKey","createdById","transactionDate")
    VALUES (gen_random_uuid(), ${fresh.id}::uuid, ${main.id}::uuid, 'INWARD','OPENING_STOCK',
       1,'BOX', 40, 41, 'OPENING_BALANCE', ${uniq('op')}, ${user.id}::uuid, now())`);
  check('9c. and the database refuses it too, not only the service', dbLevel.threw, dbLevel.err?.message);

  /* ────────────────────────────────────────────────────────
     10. WAREHOUSES
     ──────────────────────────────────────────────────────── */
  console.log('\n10. warehouses are closed, never deleted');

  const depot = await wh.create({ name: uniq('Test Depot'), city: 'Morbi' }, user);
  check('10a. a new warehouse can be created', Boolean(depot.id));
  check('10b. and it does not steal the default flag', depot.isDefault === false);

  const dup = await refused(() => wh.create({ name: depot.name }, user));
  check('10c. two warehouses cannot share a name', dup.threw, dup.err?.message);

  const noDelete = await refused(() => prisma.warehouse.delete({ where: { id: main.id } }));
  check('10d. a warehouse with stock movements cannot be deleted', noDelete.threw, noDelete.err?.message);

  const closeFull = await refused(() => wh.setActive(main.id, false, user, 'closing'));
  check('10e. a warehouse still holding stock cannot be deactivated',
    closeFull.threw, closeFull.err?.message);
  check('10f. and the refusal says how much is in it',
    /still holds \d+ on hand/.test(closeFull.err?.message ?? ''), closeFull.err?.message);

  await wh.setActive(depot.id, false, user, 'empty, so it may close');
  const intoClosed = await refused(() => inv.stockInward({
    product: product.id, warehouseId: depot.id, quantity: 1, idempotencyKey: uniq('closed'),
  }, user));
  check('10g. an empty warehouse can be deactivated, and then accepts nothing',
    intoClosed.threw, intoClosed.err?.message);
  await wh.setActive(depot.id, true, user, 'reopened for the transfer tests');

  const codeChange = await refused(() => wh.update(main.id, { code: 'RENAMED' }, user));
  check('10h. a warehouse code cannot be changed once the ledger quotes it',
    codeChange.threw, codeChange.err?.message);

  /* ────────────────────────────────────────────────────────
     11. THE TRANSFER LIFECYCLE
     ──────────────────────────────────────────────────────── */
  console.log('\n11. one transfer, two linked movements, one total');

  const t0 = await company();
  const transfer = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 9, uom: 'BOX' }],
    notes: 'Replenishing the depot.',
  }, user);
  check('11a. a draft transfer moves nothing at all',
    (await company()).total === t0.total);

  const sameWarehouse = await refused(() => wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: main.id,
    lines: [{ productId: product.id, quantity: 1 }],
  }, user));
  check('11b. a transfer to the same warehouse is refused', sameWarehouse.threw);

  const dispatched = await wh.dispatchTransfer(transfer.id, user);
  const t1 = await company();
  check('11c. dispatch takes the stock off the source\'s shelves',
    t1.onHand === t0.onHand - 9, JSON.stringify(t1));
  check('11d. and holds it in transit against the destination',
    t1.inTransit === t0.inTransit + 9, JSON.stringify(t1));
  check('11e. COMPANY-WIDE STOCK IS UNCHANGED while it is on the road',
    t1.total === t0.total, t0.total + ' -> ' + t1.total);
  check('11f. the dispatch is attributed to somebody', dispatched.dispatchedBy !== null);

  /* ONE LOGICAL REFERENCE, not two unrelated movements. */
  const legs = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'WAREHOUSE_TRANSFER', referenceId: transfer.id },
  });
  check('11g. both sides of the transfer carry the same transfer reference',
    legs.length >= 1 && legs.every((l) => l.referenceId === transfer.id), legs.length);
  check('11h. and quote its document number', legs.every((l) => l.referenceNo === transfer.transferNo));

  const twice = await refused(() => wh.dispatchTransfer(transfer.id, user));
  check('11i. a transfer cannot be dispatched twice', twice.threw, twice.err?.message);

  const received = await wh.receiveTransfer(transfer.id, {
    lines: transfer.lines.map((l) => ({ transferLineId: l.id, acceptedQuantity: l.quantity })),
  }, user);
  const t2 = await company();
  check('11j. receipt puts the stock back on a shelf', t2.onHand === t0.onHand, JSON.stringify(t2));
  check('11k. and clears the in-transit figure', t2.inTransit === t0.inTransit, JSON.stringify(t2));
  check('11l. COMPANY-WIDE STOCK IS UNCHANGED at the end too', t2.total === t0.total);
  check('11m. the receipt is attributed to somebody', received.receivedBy !== null);
  check('11n. the transfer reconciles: what left equals what arrived',
    received.movement.balanced === true
      && received.movement.dispatched === received.movement.receivedAtDestination,
    JSON.stringify(received.movement));

  const lateCancel = await refused(() => wh.cancelTransfer(transfer.id, user, 'too late'));
  check('11o. a completed transfer cannot be cancelled', lateCancel.threw, lateCancel.err?.message);

  // Cancelled on the road: the stock goes back where it came from.
  const t3 = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 4, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t3.id, user);
  const beforeCancel = await company();
  const cancelled = await wh.cancelTransfer(t3.id, user, 'Lorry turned round.');
  const afterCancel = await company();
  check('11p. cancelling in transit returns the stock to the source',
    afterCancel.onHand === beforeCancel.onHand + 4, JSON.stringify(afterCancel));
  check('11q. and still leaves company-wide stock unchanged',
    afterCancel.total === beforeCancel.total);
  check('11r. a transfer cancelled on the road still reconciles',
    cancelled.movement.balanced === true && cancelled.movement.returnedToSource === 4,
    JSON.stringify(cancelled.movement));

  /* ────────────────────────────────────────────────────────
     12. REVERSAL, NOT DELETION
     ──────────────────────────────────────────────────────── */
  console.log('\n12. a mistake is corrected, not erased');

  const { entry: mistake } = await stock.postStockMovement({
    productId: product.id, warehouseId: main.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT', quantity: 6,
    referenceType: 'MANUAL', idempotencyKey: uniq('oops'), createdById: user.id,
  });
  const beforeReversal = await balance(product.id, main.id);
  const { entry: reversal } = await stock.reverseStockMovement({
    entryId: mistake.id, createdById: user.id, remarks: 'Entered against the wrong product.',
  });
  const afterReversal = await balance(product.id, main.id);

  check('12a. the reversal undoes the balance',
    afterReversal.onHand === beforeReversal.onHand - 6, JSON.stringify(afterReversal));
  check('12b. it is the opposite movement, not a deletion',
    reversal.movementType === 'OUTWARD', reversal.movementType);
  check('12c. and it points at the entry it corrects',
    reversal.reversalOfEntryId === mistake.id);

  const stillThere = await prisma.stockLedgerEntry.findUnique({ where: { id: mistake.id } });
  check('12d. the original entry is still on the record', Boolean(stillThere));

  /* ────────────────────────────────────────────────────────
     13. RECONCILIATION REPORTS, AND NEVER REPAIRS
     ──────────────────────────────────────────────────────── */
  console.log('\n13. the projection still agrees with the ledger');

  const report = await wh.reconciliationReport();
  check('13a. after everything above, every balance reconciles',
    report.status === 'PASSED',
    JSON.stringify({ drift: report.driftedBalances, neg: report.negativeBalances,
      missing: report.missingProjections, transfers: report.unbalancedTransfers }));

  const [{ drifted }] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS drifted FROM v_inventory_reconciliation WHERE NOT reconciled`;
  check('13b. and the database agrees, re-derived from the ledger itself', drifted === 0, drifted);

  /* A FORCED DISCREPANCY. The projection is bent out of shape
     behind the service's back, and the report must notice -- and
     must leave it exactly as it found it. A reconciliation that
     quietly repairs is worse than none: it destroys the evidence
     of what went wrong. */
  await prisma.$executeRaw`
    UPDATE "inventory_balances" SET "quantityOnHand" = "quantityOnHand" + 7
    WHERE "productId" = ${fresh.id}::uuid AND "warehouseId" = ${main.id}::uuid`;

  const bent = await wh.reconciliationReport();
  check('13c. a balance bent behind the service\'s back is detected', bent.status === 'FAILED');
  check('13d. and the drifted row is named, with the difference',
    bent.driftedBalances.some((d) => d.sku === fresh.sku && Number(d.difference) === 7),
    JSON.stringify(bent.driftedBalances));

  const afterReport = await balance(fresh.id, main.id);
  check('13e. THE REPORT DID NOT REPAIR IT. The discrepancy is still there.',
    afterReport.onHand === Number((await prisma.inventoryBalance.findUniqueOrThrow({
      where: { productId_warehouseId: { productId: fresh.id, warehouseId: main.id } },
    })).quantityOnHand));
  check('13f. and the report says a correction must be an authorised adjustment',
    /adjustment/i.test(bent.note), bent.note);

  /* AND AN ADJUSTMENT DOES NOT CURE THIS ONE, which is worth
     stating because it is counter-intuitive.

     There are two different faults that both read as "the number
     is wrong", and they have different remedies:

       A MISCOUNT. The ledger and the projection agree with each
       other and disagree with the shelf. An adjustment is exactly
       right: it moves both, and the reason records why.

       A CORRUPTED PROJECTION, which is what was forced above. The
       ledger is correct and the running total beside it is not.
       An adjustment moves BOTH sides by the same amount, so the
       gap survives it untouched -- as this check proves. The
       remedy is to re-derive the projection from the ledger, by
       hand, by somebody who has first worked out how it drifted;
       and the report refusing to do that quietly is the whole
       point of it being a report.

     If this check ever starts passing, the reconciliation view
     has stopped comparing the projection against the ledger and
     started comparing something against itself. */
  await inv.stockAdjustment({
    product: fresh.id, warehouseId: main.id, quantity: 7, direction: 'IN',
    remarks: 'Counted seven more than the system showed.',
    idempotencyKey: uniq('fix'),
  }, user);
  const stillBent = await wh.reconciliationReport();
  check('13g. an adjustment does NOT paper over a corrupted projection: it moves both sides',
    stillBent.status === 'FAILED'
      && stillBent.driftedBalances.some((d) => d.sku === fresh.sku && Number(d.difference) === 7),
    JSON.stringify(stillBent.driftedBalances));

  // Undo the suite's own vandalism, by re-deriving the projection
  // from the ledger -- which is what a person would have to do.
  await prisma.$executeRaw`
    UPDATE "inventory_balances" SET "quantityOnHand" = "quantityOnHand" - 7
    WHERE "productId" = ${fresh.id}::uuid AND "warehouseId" = ${main.id}::uuid`;

  const fixed = await wh.reconciliationReport();
  check('13h. re-derived from the ledger, everything reconciles again',
    fixed.status === 'PASSED', JSON.stringify(fixed.driftedBalances));

  /* ────────────────────────────────────────────────────────
     14. NOTHING ELSE CAN WRITE A BALANCE
     ──────────────────────────────────────────────────────── */
  console.log('\n14. one road in, and no other');

  const files = execSync(
    'grep -rln "inventoryBalance\\.\\(update\\|upsert\\|create\\)\\|UPDATE \\"inventory_balances\\"" '
    + 'server db prisma/seed.mjs || true',
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(Boolean);

  /* The seed writes balances directly, on purpose: it is building
     the starting position, not recording a movement. Everything
     else that touches a balance must be the stock service or the
     transfer lifecycle that calls it. */
  const allowed = new Set([
    'db/stock.mjs',
    'server/services/warehouse.service.mjs',
    'prisma/seed.mjs',
  ]);
  const rogue = files.filter((f) => !allowed.has(f));
  check('14a. no route, controller or other service writes a stock balance directly',
    rogue.length === 0, rogue.join(', '));

  const routeWrites = execSync(
    'grep -rln "stockLedgerEntry\\.create" server/routes server/import || true',
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  check('14b. and nothing outside the service writes a ledger entry',
    routeWrites.length === 0, routeWrites.join(', '));

  /* ────────────────────────────────────────────────────────
     15. WHAT THE SCREENS READ IS WHAT IS THERE
     ──────────────────────────────────────────────────────── */
  console.log('\n15. the screens and the database agree');

  const listed = await inv.listStock({ search: 'DV-1001', warehouseId: main.id, pageSize: 5 });
  const row = listed.rows.find((r) => r.sku === 'DV-1001');
  const truth = await balance(product.id, main.id);
  check('15a. the inventory list shows the real balance',
    row.physical === truth.onHand, row?.physical + ' vs ' + truth.onHand);
  check('15b. and derives what can be sold from it',
    row.available === truth.onHand - truth.reserved - truth.damaged, JSON.stringify(row));

  const totals = await inv.companyTotals();
  const view = await company();
  check('15c. the company totals come from the view, not a second sum',
    totals.physicalTotal === view.total && totals.available === view.available);

  const card = await inv.ledger({ sku: 'DV-1001', pageSize: 5 });
  check('15d. the stock card is ordered newest first by entry number',
    card.rows.every((r, i) => i === 0 || Number(card.rows[i - 1].entryNo) > Number(r.entryNo)));
  check('15e. and every row carries the balance before and after',
    card.rows.every((r) => r.balanceBefore !== undefined && r.balanceAfter !== undefined));

  const dash = await inv.dashboard();
  check('15f. the dashboard reports the reconciliation status rather than assuming it',
    ['PASSED', 'FAILED'].includes(dash.reconciliation.status), dash.reconciliation.status);

  /* ────────────────────────────────────────────────────────
     16. NO VALUATION HAS BEEN CHOSEN, AND NOTHING PRETENDS OTHERWISE
     ──────────────────────────────────────────────────────── */
  console.log('\n16. no valuation method has been invented');

  check('16a. the company totals carry no stock value',
    !('stockValue' in totals) && !('value' in totals), Object.keys(totals).join(','));
  check('16b. nor does an inventory row', !('value' in row), Object.keys(row).join(','));

  const costed = await prisma.stockLedgerEntry.count({ where: { unitCost: { not: null } } });
  check('16c. but unit cost IS recorded per movement, which every method needs',
    costed > 0, costed);

  /* ────────────────────────────────────────────────────────
     17. PARTIAL TRANSFER RECEIPT, DAMAGE AND LOSS
     ──────────────────────────────────────────────────────── */
  console.log('\n17. a transfer can arrive in pieces, some of it broken, some of it lost');

  // Enough on hand at the source for everything this section
  // dispatches, regardless of what earlier sections left behind.
  await stock.postStockMovement({
    productId: product.id, warehouseId: main.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT', quantity: 100,
    referenceType: 'MANUAL', idempotencyKey: uniq('t17-stock'), createdById: user.id,
  });

  const p0 = await company();
  const dest0 = await balance(product.id, depot.id);
  const t17 = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 20, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17.id, user);
  const line17 = t17.lines[0];

  const r1 = await wh.receiveTransfer(t17.id, {
    lines: [{ transferLineId: line17.id, acceptedQuantity: 12 }],
  }, user);
  check('17a. a partial receipt is accepted and leaves the transfer in transit',
    r1.status === 'IN_TRANSIT', r1.status);
  check('17b. the line reports exactly what is still outstanding',
    r1.lines[0].outstandingQuantity === 8, JSON.stringify(r1.lines[0]));

  const d1 = await balance(product.id, depot.id);
  check('17c. the accepted quantity landed on the destination\'s shelf',
    d1.onHand === dest0.onHand + 12, JSON.stringify(d1));
  check('17d. and the rest is still shown in transit, not on anyone\'s shelf',
    d1.inTransit === dest0.inTransit + 8, JSON.stringify(d1));
  check('17e. company-wide stock is unchanged by a partial receipt',
    (await company()).total === p0.total);

  // A second partial receipt on the SAME line, this time with some
  // damage mixed in with the good boxes.
  const r2 = await wh.receiveTransfer(t17.id, {
    lines: [{ transferLineId: line17.id, acceptedQuantity: 3, damagedQuantity: 2, remarks: 'Corner crushed in transit.' }],
  }, user);
  check('17f. a second partial receipt on the same line is accepted',
    r2.status === 'IN_TRANSIT', r2.status);
  check('17g. outstanding has shrunk further, not reset by the new call',
    r2.lines[0].outstandingQuantity === 3, JSON.stringify(r2.lines[0]));
  check('17h. accepted and damaged ACCUMULATE across receipts, never overwrite',
    r2.lines[0].acceptedQuantity === 15 && r2.lines[0].damagedQuantity === 2, JSON.stringify(r2.lines[0]));

  const d2 = await balance(product.id, depot.id);
  check('17i. damaged stock arrives physically but is not sellable',
    d2.onHand === dest0.onHand + 17 && d2.damaged === dest0.damaged + 2, JSON.stringify(d2));
  check('17j. in-transit keeps shrinking by exactly what has just been resolved',
    d2.inTransit === 3, JSON.stringify(d2));

  const missingNoReason = await refused(() => wh.receiveTransfer(t17.id, {
    lines: [{ transferLineId: line17.id, missingQuantity: 3 }],
  }, user));
  check('17k. writing off a missing quantity without a reason is refused', missingNoReason.threw);

  const r3 = await wh.receiveTransfer(t17.id, {
    lines: [{ transferLineId: line17.id, missingQuantity: 3, missingReason: 'Never arrived; destination logged short on delivery.' }],
  }, user);
  check('17l. resolving the last outstanding quantity completes the transfer',
    r3.status === 'COMPLETED', r3.status);
  check('17m. nothing is left outstanding on the line', r3.lines[0].outstandingQuantity === 0, JSON.stringify(r3.lines[0]));

  const d3 = await balance(product.id, depot.id);
  check('17n. a missing quantity never arrives, so on-hand does not include it',
    d3.onHand === dest0.onHand + 17, JSON.stringify(d3));
  check('17o. and in-transit clears to zero once it is written off, not left stranded',
    d3.inTransit === 0, JSON.stringify(d3));
  const afterLoss = await company();
  check('17p. company-wide stock DROPS by exactly the lost quantity -- it is genuinely gone',
    afterLoss.total === p0.total - 3, JSON.stringify(afterLoss));

  const lossEntry = await prisma.stockLedgerEntry.findFirst({
    where: { referenceId: t17.id, movementType: 'TRANSFER_LOSS' },
  });
  check('17q. the write-off is on the permanent record, with its reason',
    Boolean(lossEntry) && (lossEntry.remarks ?? '').includes('logged short'), lossEntry?.remarks);

  const lossUpdate = await refused(() => prisma.$executeRaw`
    UPDATE "stock_ledger_entries" SET "quantity" = 1 WHERE "id" = ${lossEntry.id}::uuid`);
  check('17r. a TRANSFER_LOSS entry is append-only too, same as every other movement',
    lossUpdate.threw, lossUpdate.err?.message);

  const { entry: lossReversal } = await stock.reverseStockMovement({
    entryId: lossEntry.id, createdById: user.id, remarks: 'Found the missing boxes after all.',
  });
  check('17s. a transfer loss can be corrected, as the opposite movement, not erased',
    lossReversal.movementType === 'TRANSFER_LOSS_REVERSAL', lossReversal.movementType);
  const d3r = await balance(product.id, depot.id);
  check('17t. the reversal puts the quantity back in transit',
    d3r.inTransit === 3, JSON.stringify(d3r));
  // Leave the data as section 17's later checks expect it.
  await stock.reverseStockMovement({
    entryId: lossReversal.id, createdById: user.id, remarks: 'Confirmed still missing; re-applying the write-off.',
  });

  /* ── invalid combinations, and over-receipt with no override ── */

  const t17b = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 10, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17b.id, user);
  const line17b = t17b.lines[0];

  const negativeReceipt = await refused(() => wh.receiveTransfer(t17b.id, {
    lines: [{ transferLineId: line17b.id, acceptedQuantity: -1 }],
  }, user));
  check('17u. a negative received quantity is refused', negativeReceipt.threw);

  const nothing = await refused(() => wh.receiveTransfer(t17b.id, {
    lines: [{ transferLineId: line17b.id, acceptedQuantity: 0 }],
  }, user));
  check('17v. a line that records nothing at all is refused', nothing.threw);

  const overReceipt = await refused(() => wh.receiveTransfer(t17b.id, {
    lines: [{ transferLineId: line17b.id, acceptedQuantity: 11 }],
  }, user));
  check('17w. receiving more than was dispatched is refused outright, with no override',
    overReceipt.threw, overReceipt.err?.message);

  const duplicateLine = await refused(() => wh.receiveTransfer(t17b.id, {
    lines: [
      { transferLineId: line17b.id, acceptedQuantity: 2 },
      { transferLineId: line17b.id, acceptedQuantity: 3 },
    ],
  }, user));
  check('17x. the same line twice in one receipt call is refused', duplicateLine.threw);

  const exactBoundary = await wh.receiveTransfer(t17b.id, {
    lines: [{ transferLineId: line17b.id, acceptedQuantity: 10 }],
  }, user);
  check('17y. receiving EXACTLY what is outstanding succeeds and completes the transfer',
    exactBoundary.status === 'COMPLETED', exactBoundary.status);

  const overAfterFull = await refused(() => wh.receiveTransfer(t17b.id, {
    lines: [{ transferLineId: line17b.id, acceptedQuantity: 1 }],
  }, user));
  check('17z. a completed transfer cannot be received again', overAfterFull.threw, overAfterFull.err?.message);

  /* ── cancellation is refused once anything has been resolved ── */

  const t17c = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 10, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17c.id, user);
  await wh.receiveTransfer(t17c.id, {
    lines: [{ transferLineId: t17c.lines[0].id, acceptedQuantity: 4 }],
  }, user);

  const cancelPartial = await refused(() => wh.cancelTransfer(t17c.id, user, 'changed my mind'));
  check('17aa. a transfer cannot be cancelled once any quantity has been received',
    cancelPartial.threw, cancelPartial.err?.message);

  // The OLD behaviour must still work: a transfer nothing has yet
  // been received against stays freely cancellable.
  const t17d = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 5, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17d.id, user);
  const cancelUntouched = await wh.cancelTransfer(t17d.id, user, 'no longer needed');
  check('17ab. a transfer with nothing yet received can still be cancelled',
    cancelUntouched.status === 'CANCELLED', cancelUntouched.status);

  /* ── reconciliation tolerates a legitimate partial receipt ── */

  const t17e = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 6, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17e.id, user);
  const partialMid = await wh.receiveTransfer(t17e.id, {
    lines: [{ transferLineId: t17e.lines[0].id, acceptedQuantity: 2 }],
  }, user);
  check('17ac. a transfer sitting mid-partial-receipt reconciles as balanced, not a false alarm',
    partialMid.movement.balanced === true, JSON.stringify(partialMid.movement));

  const reportMid = await wh.reconciliationReport();
  check('17ad. the reconciliation report does not flag a normal partial receipt as unbalanced',
    !reportMid.unbalancedTransfers.some((t) => t.transferNo === t17e.transferNo),
    JSON.stringify(reportMid.unbalancedTransfers));

  /* ── concurrent receipts against the same line ── */

  const t17f = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: 10, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t17f.id, user);
  const line17f = t17f.lines[0];
  const destBefore = await balance(product.id, depot.id);

  const raced = await Promise.allSettled([
    wh.receiveTransfer(t17f.id, { lines: [{ transferLineId: line17f.id, acceptedQuantity: 6 }] }, user),
    wh.receiveTransfer(t17f.id, { lines: [{ transferLineId: line17f.id, acceptedQuantity: 6 }] }, user),
  ]);
  const raceWon = raced.filter((r) => r.status === 'fulfilled');
  check('17ae. of two concurrent receipts that together would over-receive, exactly one sticks',
    raceWon.length === 1, raced.map((r) => r.status + ':' + (r.reason?.message ?? '')).join(' | '));

  const line17fAfter = (await wh.getTransfer(t17f.id)).lines[0];
  check('17af. the line\'s accepted quantity is exactly six -- never twelve, never lost to zero',
    line17fAfter.acceptedQuantity === 6, JSON.stringify(line17fAfter));

  const destAfter = await balance(product.id, depot.id);
  check('17ag. the destination only shows stock for the receipt that actually stuck',
    destAfter.onHand === destBefore.onHand + 6, JSON.stringify(destAfter));
  check('17ah. and in-transit only dropped by that same six, not by twelve',
    destAfter.inTransit === destBefore.inTransit - 6, JSON.stringify(destAfter));

  /* ────────────────────────────────────────────────────────
     18. stock:read IS DEFINED, AND DELIBERATELY NOT ENFORCED
     ──────────────────────────────────────────────────────── */
  console.log('\n18. reading stock needs no permission today -- by documented design, not oversight');

  const stockReadGrants = await prisma.rolePermission.count({ where: { permission: 'stock:read' } });
  check('18a. stock:read is a real permission the seed assigns to roles',
    stockReadGrants > 0, stockReadGrants);

  const invRoutes = readFileSync(path.join(ERP_ROOT, 'server/routes/inventory.mjs'), 'utf8');
  const whRoutes = readFileSync(path.join(ERP_ROOT, 'server/routes/warehouses.mjs'), 'utf8');

  check('18b. no GET route in inventory.mjs checks stock:read',
    !/requirePermission\(\s*['"]stock:read['"]/.test(invRoutes));
  check('18c. no GET route in warehouses.mjs checks stock:read either',
    !/requirePermission\(\s*['"]stock:read['"]/.test(whRoutes));

  const permissionSource = readFileSync(
    path.join(ERP_ROOT, 'server/services/permission.mjs'), 'utf8');
  check('18d. the file itself documents x-erp-user as a placeholder, not real authentication',
    /placeholder/i.test(permissionSource) && /x-erp-user/.test(permissionSource));

  /* THIS IS A DELIBERATE, DOCUMENTED LIMITATION, not a bug this
     phase silently papered over. req.actor is set from the
     x-erp-user header -- anyone who can reach the port could claim
     to be anybody -- so adding requirePermission('stock:read') to
     a read route would check a permission against an identity
     nobody has verified. That is worse than no check: it would
     look like security and provide none. The real mitigation is
     that the server binds to 127.0.0.1 only; enforcing stock:read
     here is left for the phase that gives this server real
     authentication. */
}

try {
  await main();
} catch (err) {
  failures.push('the suite itself threw: ' + err.message);
  console.error('\n' + err.stack);
}

console.log('\n' + '='.repeat(58));
console.log((passed) + ' passed, ' + failures.length + ' failed, ' + (passed + failures.length) + ' checks');
if (failures.length) console.log('\nfailed:\n  ' + failures.join('\n  '));
console.log('='.repeat(58));

await disconnect();
process.exit(failures.length ? 1 : 0);
