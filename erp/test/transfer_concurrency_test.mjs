import { execSync } from 'node:child_process';
import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/* ============================================================
   THE CANCEL/RECEIVE RACE, EXERCISED FOR REAL
   ============================================================

   A verification pass found that cancelTransfer() and
   receiveTransfer() could both validate against a transfer's
   stale, pre-transaction state and both proceed -- in roughly two
   runs out of five, the same dispatched quantity ended up counted
   as BOTH returned to the source AND received at the destination.
   Phantom stock, created by two operations that were each correct
   on their own.

   The fix: both functions now take a SELECT ... FOR UPDATE lock on
   the warehouse_transfers row itself, as the very first statement
   inside their transaction, and re-read and re-validate the
   transfer's status and resolved quantities from INSIDE that lock
   -- never from the plain read taken before the transaction opened.

   This suite does not take that on faith. Every racy scenario
   below is run MANY times, against a fresh transfer each time, and
   checked for the invariants that actually matter: exactly one
   side wins, the loser gets a named business error rather than a
   raw database exception, and nothing about company-wide stock,
   the ledger, or the reconciliation view is ever left wrong.

   ON ITS OWN DATABASE, same convention as every other suite here.

   Run:  node test/transfer_concurrency_test.mjs
   ============================================================ */

const DB = 'devyora_erp_transfer_concurrency_test';

if (!/_test$/.test(DB)) {
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
const wh = await import('../server/services/warehouse.service.mjs');

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + String(extra).slice(0, 300)));
}

async function refused(fn) {
  try { const value = await fn(); return { threw: false, value }; }
  catch (err) { return { threw: true, err }; }
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

async function company() {
  const [r] = await prisma.$queryRaw`
    SELECT physical_on_hand::text a, in_transit::text b, physical_total::text c
    FROM v_company_stock`;
  return { onHand: Number(r.a), inTransit: Number(r.b), total: Number(r.c) };
}

const uniq = (s) => s + '-' + Math.random().toString(36).slice(2, 8);

async function freshTransfer(main, depot, product, qty) {
  const t = await wh.createTransfer({
    fromWarehouseId: main.id, toWarehouseId: depot.id,
    lines: [{ productId: product.id, quantity: qty, uom: 'BOX' }],
  }, user);
  await wh.dispatchTransfer(t.id, user);
  return t;
}

let user, main, depot, product;

async function main_() {
  user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
  main = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  product = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1001' } });
  depot = await wh.create({ name: uniq('Concurrency Depot'), city: 'Morbi' }, user);

  // Plenty of stock at the source for every trial below.
  await stock.postStockMovement({
    productId: product.id, warehouseId: main.id,
    movementType: 'INWARD', reason: 'PURCHASE_RECEIPT', quantity: 100000,
    referenceType: 'MANUAL', idempotencyKey: uniq('concurrency-stock'), createdById: user.id,
  });

  const ITERATIONS = 30;

  /* ────────────────────────────────────────────────────────
     1 & 2. CANCEL vs RECEIVE, BOTH STARTING ORDERS
     ──────────────────────────────────────────────────────── */
  console.log('\n1&2. cancel and receive, fired concurrently, both array orders, ' + ITERATIONS + ' iterations each');

  const outcomeTally = { cancelWon: 0, receiveWon: 0, bothSucceeded: 0, neitherSucceeded: 0 };
  let phantomStockEver = false;
  let rawDbErrorEver = false;

  for (let order = 0; order < 2; order++) {
    for (let i = 0; i < ITERATIONS; i++) {
      const t = await freshTransfer(main, depot, product, 10);
      const line = t.lines[0];
      const before = await company();

      const cancelCall = () => wh.cancelTransfer(t.id, user, 'race test');
      const receiveCall = () => wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 10 }] }, user);

      const calls = order === 0 ? [cancelCall(), receiveCall()] : [receiveCall(), cancelCall()];
      const results = await Promise.allSettled(calls);
      const [first, second] = order === 0 ? results : [results[1], results[0]];
      const cancelResult = first;
      const receiveResult = second;

      const cancelOk = cancelResult.status === 'fulfilled';
      const receiveOk = receiveResult.status === 'fulfilled';

      if (cancelOk && receiveOk) outcomeTally.bothSucceeded += 1;
      else if (cancelOk) outcomeTally.cancelWon += 1;
      else if (receiveOk) outcomeTally.receiveWon += 1;
      else outcomeTally.neitherSucceeded += 1;

      // The loser, when there is exactly one, must get a NAMED
      // business error (ConflictError, status 409) -- not a raw
      // Prisma/Postgres exception leaking through.
      for (const r of [cancelResult, receiveResult]) {
        if (r.status === 'rejected' && r.reason?.code !== 'CONFLICT' && r.reason?.status !== 409) {
          rawDbErrorEver = true;
        }
      }

      const after = await company();
      if (after.total !== before.total) phantomStockEver = true;
    }
  }

  check('1&2a. in ' + (ITERATIONS * 2) + ' concurrent cancel/receive trials, never did both succeed',
    outcomeTally.bothSucceeded === 0, JSON.stringify(outcomeTally));
  check('1&2b. at least one side won in every trial (no trial left the transfer stuck)',
    outcomeTally.neitherSucceeded === 0, JSON.stringify(outcomeTally));
  check('1&2c. company-wide physical stock was never changed by the race itself',
    !phantomStockEver);
  check('1&2d. the losing call always received a controlled business error, never a raw database exception',
    !rawDbErrorEver);
  console.log('    tally: ' + JSON.stringify(outcomeTally));

  /* ────────────────────────────────────────────────────────
     3. TWO SIMULTANEOUS PARTIAL RECEIPTS
     ──────────────────────────────────────────────────────── */
  console.log('\n3. two simultaneous partial receipts that together would over-receive, ' + ITERATIONS + ' iterations');

  let partialBothSucceeded = 0;
  let partialNeitherSucceeded = 0;
  let partialOverReceived = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const t = await freshTransfer(main, depot, product, 10);
    const line = t.lines[0];

    const results = await Promise.allSettled([
      wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 6 }] }, user),
      wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 6 }] }, user),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    if (won.length === 2) partialBothSucceeded += 1;
    if (won.length === 0) partialNeitherSucceeded += 1;

    const finalLine = (await wh.getTransfer(t.id)).lines[0];
    if (Number(finalLine.acceptedQuantity) > 10) partialOverReceived += 1;
  }

  check('3a. two concurrent partial receipts never both succeed when together they would over-receive',
    partialBothSucceeded === 0, partialBothSucceeded);
  check('3b. and at least one of the two always succeeds', partialNeitherSucceeded === 0, partialNeitherSucceeded);
  check('3c. the line\'s accepted quantity never exceeds what was dispatched, across all trials',
    partialOverReceived === 0, partialOverReceived);

  /* ────────────────────────────────────────────────────────
     4. TWO SIMULTANEOUS FULL RECEIPTS
     ──────────────────────────────────────────────────────── */
  console.log('\n4. two simultaneous FULL receipts on the same transfer, ' + ITERATIONS + ' iterations');

  let fullBothSucceeded = 0;
  let fullNeitherSucceeded = 0;
  let fullLoserRawError = 0;

  for (let i = 0; i < ITERATIONS; i++) {
    const t = await freshTransfer(main, depot, product, 7);
    const line = t.lines[0];

    const results = await Promise.allSettled([
      wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 7 }] }, user),
      wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 7 }] }, user),
    ]);
    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');
    if (won.length === 2) fullBothSucceeded += 1;
    if (won.length === 0) fullNeitherSucceeded += 1;
    for (const r of lost) {
      if (r.reason?.code !== 'CONFLICT' && r.reason?.status !== 409) fullLoserRawError += 1;
    }

    const finalLine = (await wh.getTransfer(t.id)).lines[0];
    if (Number(finalLine.acceptedQuantity) > 7) fullBothSucceeded += 1; // belt and braces
  }

  check('4a. two concurrent full receipts on the same transfer never both succeed',
    fullBothSucceeded === 0, fullBothSucceeded);
  check('4b. exactly one always succeeds', fullNeitherSucceeded === 0, fullNeitherSucceeded);
  check('4c. the loser gets the friendly "already COMPLETED" conflict, not a raw constraint error',
    fullLoserRawError === 0, fullLoserRawError);

  /* ────────────────────────────────────────────────────────
     5. OVER-RECEIPT ATTEMPTS (deterministic, not a race -- run
        repeatedly anyway, to prove it never flakes)
     ──────────────────────────────────────────────────────── */
  console.log('\n5. over-receipt is refused outright, every time, ' + 10 + ' iterations');

  let overReceiptAccepted = 0;
  for (let i = 0; i < 10; i++) {
    const t = await freshTransfer(main, depot, product, 5);
    const line = t.lines[0];
    const over = await refused(() => wh.receiveTransfer(t.id, {
      lines: [{ transferLineId: line.id, acceptedQuantity: 6 }],
    }, user));
    if (!over.threw) overReceiptAccepted += 1;
  }
  check('5a. over-receipt is refused in every one of 10 attempts', overReceiptAccepted === 0, overReceiptAccepted);

  /* ────────────────────────────────────────────────────────
     6. CANCELLATION AFTER A PARTIAL (ACCEPTED) RECEIPT
     ──────────────────────────────────────────────────────── */
  console.log('\n6. cancellation after a partial accepted receipt is refused, every time, 10 iterations');

  let cancelAfterPartialAccepted = 0;
  for (let i = 0; i < 10; i++) {
    const t = await freshTransfer(main, depot, product, 10);
    const line = t.lines[0];
    await wh.receiveTransfer(t.id, { lines: [{ transferLineId: line.id, acceptedQuantity: 3 }] }, user);
    const cancelled = await refused(() => wh.cancelTransfer(t.id, user, 'trying anyway'));
    if (!cancelled.threw) cancelAfterPartialAccepted += 1;
  }
  check('6a. cancellation after a partial accepted receipt is refused in every attempt',
    cancelAfterPartialAccepted === 0, cancelAfterPartialAccepted);

  /* ────────────────────────────────────────────────────────
     7. CANCELLATION AFTER MISSING/DAMAGED QUANTITIES ARE
        RECORDED (no accepted quantity at all)
     ──────────────────────────────────────────────────────── */
  console.log('\n7. cancellation after a damaged-only and a missing-only receipt is refused, 10 iterations each');

  let cancelAfterDamagedAccepted = 0;
  let cancelAfterMissingAccepted = 0;
  for (let i = 0; i < 10; i++) {
    const tD = await freshTransfer(main, depot, product, 10);
    const lineD = tD.lines[0];
    await wh.receiveTransfer(tD.id, { lines: [{ transferLineId: lineD.id, damagedQuantity: 3, remarks: 'crushed' }] }, user);
    const cancelledD = await refused(() => wh.cancelTransfer(tD.id, user, 'trying anyway'));
    if (!cancelledD.threw) cancelAfterDamagedAccepted += 1;

    const tM = await freshTransfer(main, depot, product, 10);
    const lineM = tM.lines[0];
    await wh.receiveTransfer(tM.id, {
      lines: [{ transferLineId: lineM.id, missingQuantity: 3, missingReason: 'short delivery' }],
    }, user);
    const cancelledM = await refused(() => wh.cancelTransfer(tM.id, user, 'trying anyway'));
    if (!cancelledM.threw) cancelAfterMissingAccepted += 1;
  }
  check('7a. cancellation after a damaged-only receipt is refused in every attempt',
    cancelAfterDamagedAccepted === 0, cancelAfterDamagedAccepted);
  check('7b. cancellation after a missing-only receipt is refused in every attempt',
    cancelAfterMissingAccepted === 0, cancelAfterMissingAccepted);

  /* ────────────────────────────────────────────────────────
     8. WHOLE-SUITE INTEGRITY, AFTER EVERYTHING ABOVE
     ──────────────────────────────────────────────────────── */
  console.log('\n8. integrity, after ' + (ITERATIONS * 4 + 50) + ' transfers and every race above');

  const report = await wh.reconciliationReport();
  check('8a. zero reconciliation drift across every balance touched by this suite',
    report.driftedBalances.length === 0, report.driftedBalances);
  check('8b. zero negative balances', report.negativeBalances.length === 0, report.negativeBalances);
  check('8c. zero missing projections', report.missingProjections.length === 0, report.missingProjections);
  check('8d. zero unbalanced transfers, across every transfer this suite created',
    report.unbalancedTransfers.length === 0, report.unbalancedTransfers);

  const dupKeys = await prisma.$queryRaw`
    SELECT "idempotencyKey", COUNT(*)::int AS n FROM stock_ledger_entries
    GROUP BY "idempotencyKey" HAVING COUNT(*) > 1
  `;
  check('8e. no idempotency key was ever reused -- no duplicate stock movement',
    dupKeys.length === 0, dupKeys);

  const negativeLedgerRows = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM inventory_balances
    WHERE "quantityOnHand" < 0 OR "quantityInTransit" < 0 OR "quantityDamaged" < 0 OR "quantityReserved" < 0
  `;
  check('8f. no inventory balance went negative in any dimension, at the database level',
    Number(negativeLedgerRows[0].n) === 0, negativeLedgerRows[0].n);

  const overResolved = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS n FROM warehouse_transfer_lines
    WHERE "acceptedQuantity" + "damagedQuantity" + "missingQuantity" > quantity
  `;
  check('8g. no transfer line was ever resolved beyond what was dispatched',
    Number(overResolved[0].n) === 0, overResolved[0].n);
}

try {
  await main_();
} catch (err) {
  failures.push('the suite itself threw: ' + err.message);
  console.error('\n' + err.stack);
}

console.log('\n' + '='.repeat(58));
console.log((passed) + ' passed, ' + failures.length + ' failed, ' + (passed + failures.length) + ' checks');
if (failures.length) console.log('\nfailed:\n  ' + failures.join('\n  '));
console.log('='.repeat(58));

await disconnect();
process.exitCode = failures.length ? 1 : 0;
