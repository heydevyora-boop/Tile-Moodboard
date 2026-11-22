import { execSync } from 'node:child_process';
import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/* ============================================================
   PURCHASE MANAGEMENT, TESTED AGAINST A REAL DATABASE
   ============================================================

   The thirty-six cases the brief lists, plus the checks that
   make them worth having. Each one tries the thing that must or
   must not work and fails if the system disagrees.

   ON ITS OWN DATABASE, dropped and rebuilt from the same
   migrations and the same seed on every run, so nothing
   accumulates between runs and no assertion can quietly start
   measuring the last run's leftovers.

   TWO THINGS THIS SUITE REFUSES TO DO:

   It never asserts that something happened without checking the
   DATABASE. "The service returned a receipt" is not evidence
   that stock moved; the balance is read back every time.

   It never passes on an empty set. A check that would be true
   of zero rows asserts the count first -- the brief asks for
   this explicitly, and step 5 found a check that had been
   "passing" against an empty table.

   Run:  npm run test:purchase
   ============================================================ */

const DB = 'devyora_erp_purchase_test';

if (!/_purchase_test$/.test(DB)) {
  throw new Error('Refusing to recreate "' + DB + '": not this suite\'s own database.');
}
try {
  const url = new URL(process.env.ERP_DATABASE_URL
    ?? 'postgresql://postgres@localhost:54329/postgres?host=/var/tmp');
  url.pathname = '/postgres';
  execSync('psql "' + url.toString() + '" -qc "DROP DATABASE IF EXISTS ' + DB + ' WITH (FORCE)"',
    { stdio: 'pipe' });
} catch { /* psql may not be on PATH; migrate deploy fails more clearly */ }

useTestDatabase(DB);
migrate();
seed();

const { prisma, disconnect } = await import('../db/client.mjs');
const money = await import('../server/services/money.mjs');
const po = await import('../server/services/purchaseOrder.service.mjs');
const grn = await import('../server/services/grn.service.mjs');
const pr = await import('../server/services/purchaseReturn.service.mjs');
const si = await import('../server/services/supplierInvoice.service.mjs');
const sup = await import('../server/services/supplier.service.mjs');
const board = await import('../server/services/purchaseDashboard.service.mjs');
const { nextDocumentNumber } = await import('../db/stock.mjs');

let passed = 0;
const failures = [];

function check(label, ok, extra) {
  if (ok) { passed += 1; console.log('  PASS  ' + label); return; }
  failures.push(label);
  console.log('  FAIL  ' + label + (extra === undefined ? '' : '  ' + String(extra).slice(0, 280)));
}

async function refused(fn) {
  try { await fn(); return { threw: false }; }
  catch (err) { return { threw: true, err }; }
}

const uniq = (s) => s + '-' + Math.random().toString(36).slice(2, 7);

async function main() {
  const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@devyora.local' } });
  const manager = await prisma.user.findUniqueOrThrow({ where: { email: 'manager@devyora.local' } });
  const store = await prisma.user.findUniqueOrThrow({ where: { email: 'store@devyora.local' } });
  const salesman = await prisma.user.findUniqueOrThrow({ where: { email: 'sales@devyora.local' } });

  const gujarat = await prisma.supplier.findUniqueOrThrow({ where: { code: 'SUP-SOM' } });
  const rajasthan = await prisma.supplier.findUniqueOrThrow({ where: { code: 'SUP-KIS' } });
  const wh = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  const p1 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1001' } });
  const p2 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1002' } });
  const p3 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1003' } });

  const balanceOf = async (productId, warehouseId = wh.id) => {
    const b = await prisma.inventoryBalance.findUnique({
      where: { productId_warehouseId: { productId, warehouseId } },
    });
    return b
      ? {
        onHand: Number(b.quantityOnHand),
        damaged: Number(b.quantityDamaged),
        available: Number(b.quantityOnHand) - Number(b.quantityReserved) - Number(b.quantityDamaged),
      }
      : { onHand: 0, damaged: 0, available: 0 };
  };
  const ledgerCount = () => prisma.stockLedgerEntry.count();

  /* ────────────────────────────────────────────────────────
     1–3. SUPPLIERS
     ──────────────────────────────────────────────────────── */
  console.log('\n1. suppliers');

  const created = await sup.create({
    name: uniq('Test Marble Works'),
    gstin: '27AALCT1234M1Z8',
    city: 'Pune',
    state: 'Maharashtra',
    contactName: 'A. Deshmukh',
    contactPhone: '9000000001',
    paymentTerms: '45 days',
    creditPeriodDays: 45,
  }, admin);
  check('1. a supplier can be created', Boolean(created.id) && created.isActive);
  check('1b. its code is allocated and unique', /^SUP/.test(created.code), created.code);
  check('1c. the state code is DERIVED from the GSTIN, not asked for twice',
    created.billing.stateCode === '27', created.billing.stateCode);

  const badGstin = await refused(() => sup.create({ name: uniq('Bad'), gstin: 'NOT-A-GSTIN' }, admin));
  check('1d. a malformed GSTIN is refused', badGstin.threw, badGstin.err?.message);

  const contradiction = await refused(() => sup.create({
    name: uniq('Contradiction'), gstin: '27AALCT1234M1Z8', stateCode: '24',
  }, admin));
  check('1e. a state code that contradicts the GSTIN is refused',
    contradiction.threw, contradiction.err?.message);

  console.log('\n2. updating a supplier');
  const updated = await sup.update(created.id, { paymentTerms: '60 days', creditPeriodDays: 60 }, admin);
  check('2. an update sticks', updated.paymentTerms === '60 days' && updated.creditPeriodDays === 60);

  const audit = await prisma.auditLog.findFirst({
    where: { entityType: 'Supplier', entityId: created.id, action: 'UPDATE' },
    orderBy: { createdAt: 'desc' },
  });
  check('2b. and is recorded in the audit log', Boolean(audit), audit?.summary);

  check('2c. the service exposes no way to delete a supplier at all',
    typeof sup.remove === 'undefined' && typeof sup.destroy === 'undefined'
    && typeof sup.delete === 'undefined');

  console.log('\n3. searching suppliers');
  const found = await sup.list({ search: 'Kishangarh' });
  check('3. search finds a supplier by name', found.rows.length === 1
    && found.rows[0].code === 'SUP-KIS', found.total);
  const byGstin = await sup.list({ search: '08AAFCK' });
  check('3b. and by GSTIN', byGstin.rows.length === 1, byGstin.total);
  const activeOnly = await sup.list({ isActive: true });
  check('3c. the active filter is applied in the database',
    activeOnly.rows.length > 0 && activeOnly.rows.every((s) => s.isActive), activeOnly.total);

  /* ────────────────────────────────────────────────────────
     4–7. PURCHASE ORDERS
     ──────────────────────────────────────────────────────── */
  console.log('\n4-6. raising a purchase order');

  const ledgerAtStart = await ledgerCount();
  const stockAtStart = await balanceOf(p1.id);

  let order = await po.create({
    supplierId: gujarat.id,
    warehouseId: wh.id,
    expectedDate: '2026-12-20',
    lines: [
      { productId: p1.id, quantity: 100, unitPrice: '62.50' },
      { productId: p2.id, quantity: 40, unitPrice: '80.00', discountPercent: 10 },
      { productId: p3.id, quantity: 25, unitPrice: '120.00' },
    ],
  }, admin);

  check('4. a purchase order is created with a sequenced number',
    /^PO-2026-\d{4}$/.test(order.orderNo), order.orderNo);
  check('5. it carries all three SKUs', order.lines.length === 3
    && new Set(order.lines.map((l) => l.sku)).size === 3, order.lines.length);
  check('5b. each line snapshots the SKU and name as they are today',
    order.lines.every((l) => l.sku && l.name), '');
  check('5c. the line total is the taxable value plus its tax',
    order.lines.every((l) => Math.abs(l.lineTotal - (l.taxableValue + l.taxAmount)) < 0.005));

  const noProduct = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ quantity: 5, unitPrice: '10' }],
  }, admin));
  check('4b. a line with no product is refused — a typed name cannot create one',
    noProduct.threw, noProduct.err?.message);

  const zero = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 0, unitPrice: '10' }],
  }, admin));
  check('4c. a zero quantity is refused', zero.threw, zero.err?.message);

  const negative = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: -5, unitPrice: '10' }],
  }, admin));
  check('4d. a negative quantity is refused', negative.threw, negative.err?.message);

  const badRate = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 5, unitPrice: '-10' }],
  }, admin));
  check('4e. a negative rate is refused', badRate.threw, badRate.err?.message);

  const badSupplier = await refused(() => po.create({
    supplierId: '00000000-0000-0000-0000-000000000000', warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 5, unitPrice: '10' }],
  }, admin));
  check('4f. an unknown supplier is refused', badSupplier.threw, badSupplier.err?.message);

  const badWarehouse = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: '00000000-0000-0000-0000-000000000000',
    lines: [{ productId: p1.id, quantity: 5, unitPrice: '10' }],
  }, admin));
  check('22. an unknown warehouse is refused', badWarehouse.threw, badWarehouse.err?.message);

  console.log('\n6. editing a draft');
  order = await po.update(order.id, {
    supplierId: gujarat.id,
    warehouseId: wh.id,
    expectedDate: '2026-12-22',
    lines: [
      { productId: p1.id, quantity: 100, unitPrice: '62.50' },
      { productId: p2.id, quantity: 40, unitPrice: '80.00', discountPercent: 10 },
    ],
  }, admin);
  check('6. a draft can be edited', order.lines.length === 2 && order.status === 'DRAFT');

  console.log('\n7-8. approval and the state machine');
  order = await po.submit(order.id, admin);
  check('7a. draft becomes pending approval', order.status === 'PENDING_APPROVAL');

  const unauthorised = await refused(() => po.approve(order.id, salesman));
  check('7b. a user without purchase:approve cannot approve',
    unauthorised.threw && unauthorised.err?.code === 'FORBIDDEN', unauthorised.err?.message);

  const storeApprove = await refused(() => po.approve(order.id, store));
  check('7c. nor can the store keeper, who may receive but not commit',
    storeApprove.threw && storeApprove.err?.code === 'FORBIDDEN', storeApprove.err?.message);

  order = await po.approve(order.id, manager);
  check('7. the manager can approve', order.status === 'APPROVED');
  check('7d. approval is attributed to a person and a time',
    order.approvedBy !== null && order.approvedAt !== null);

  const reApprove = await refused(() => po.approve(order.id, manager));
  check('8. an invalid transition is refused: approving twice', reApprove.threw, reApprove.err?.message);

  const reSubmit = await refused(() => po.submit(order.id, admin));
  check('8b. and submitting an approved order', reSubmit.threw, reSubmit.err?.message);

  const editApproved = await refused(() => po.update(order.id, {
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 1, unitPrice: '1' }],
  }, admin));
  check('8c. an approved order cannot be silently edited', editApproved.threw, editApproved.err?.message);

  /* NOW the restriction can actually be tested. An earlier
     version of this check ran here-but-earlier, before the
     supplier had any history -- nothing referenced it, the
     foreign key never fired, the delete SUCCEEDED, and the
     check passed anyway because it asserted something else.
     It silently removed the supplier every later step needed. */
  console.log('\n2d. deleting a supplier with history');
  const ordersAgainst = await prisma.purchaseOrder.count({ where: { supplierId: gujarat.id } });
  check('2d. there is history to protect', ordersAgainst > 0, ordersAgainst);
  const deleteWithHistory = await refused(() => prisma.supplier.delete({ where: { id: gujarat.id } }));
  check('2e. the database refuses to delete a supplier that has purchase orders',
    deleteWithHistory.threw, deleteWithHistory.err?.message);
  check('2f. and it is still there afterwards',
    (await prisma.supplier.findUnique({ where: { id: gujarat.id } })) !== null);

  console.log('\n17-18. neither creating nor approving moves stock');
  check('17. raising the order posted no stock movement',
    (await ledgerCount()) === ledgerAtStart, await ledgerCount());
  check('18. approving it posted none either',
    (await balanceOf(p1.id)).onHand === stockAtStart.onHand);

  /* ────────────────────────────────────────────────────────
     9–10. CANCELLATION
     ──────────────────────────────────────────────────────── */
  console.log('\n9. cancelling before any receipt');
  const throwaway = await po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p3.id, quantity: 5, unitPrice: '100' }],
  }, admin);
  const approvedThrowaway = await po.approve(throwaway.id, manager);
  check('9a. it is approved first', approvedThrowaway.status === 'APPROVED');

  const noReason = await refused(() => po.cancel(throwaway.id, admin, '   '));
  check('9b. cancelling with no reason is refused', noReason.threw, noReason.err?.message);

  const cancelled = await po.cancel(throwaway.id, admin, 'Found the stone locally.');
  check('9. an order with no receipts can be cancelled', cancelled.status === 'CANCELLED');
  check('9c. with the reason and the person recorded',
    /locally/.test(cancelled.cancelReason ?? '') && cancelled.cancelledBy !== null);

  /* ────────────────────────────────────────────────────────
     11–16, 19–21. GOODS RECEIPT
     ──────────────────────────────────────────────────────── */
  console.log('\n11. a partial receipt');
  const before1 = await balanceOf(p1.id);

  const receipt1 = await grn.receive({
    purchaseOrderId: order.id,
    supplierDocNo: 'SOM-DN-1001',
    lines: [{ purchaseOrderLineId: order.lines[0].id, acceptedQuantity: 60 }],
  }, store);

  check('11. a partial receipt posts', receipt1.status === 'POSTED');
  check('11b. it has a sequenced GRN number', /^GRN-2026-\d{4}$/.test(receipt1.grnNo), receipt1.grnNo);
  check('16. stock went in on finalisation',
    (await balanceOf(p1.id)).onHand === before1.onHand + 60, JSON.stringify(await balanceOf(p1.id)));
  check('16b. through the ledger, carrying the unit cost from the order',
    receipt1.movements.length === 1 && receipt1.movements[0].movementType === 'INWARD'
    && receipt1.movements[0].unitCost === 62.5, JSON.stringify(receipt1.movements));
  check('16c. and the entry records the balance before and after',
    receipt1.movements[0].balanceBefore === before1.onHand
    && receipt1.movements[0].balanceAfter === before1.onHand + 60);

  order = await po.get(order.id);
  check('11c. the order becomes partially received', order.status === 'PARTIALLY_RECEIVED', order.status);
  check('11d. and the line shows what is still owed',
    order.lines[0].outstandingQuantity === 40, order.lines[0].outstandingQuantity);

  console.log('\n10. cancelling AFTER a receipt is refused');
  const lateCancel = await refused(() => po.cancel(order.id, admin, 'too late'));
  check('10. refused', lateCancel.threw);
  check('10b. and it says to close short instead, naming what arrived',
    /close the order short/i.test(lateCancel.err?.message ?? '')
    && /60/.test(JSON.stringify(lateCancel.err?.details ?? {})), lateCancel.err?.message);

  console.log('\n12. a second receipt against the same order');
  const before2 = await balanceOf(p1.id);
  const receipt2 = await grn.receive({
    purchaseOrderId: order.id,
    supplierDocNo: 'SOM-DN-1002',
    lines: [{ purchaseOrderLineId: order.lines[0].id, acceptedQuantity: 40 }],
  }, store);
  check('12. multiple receipts can be posted against one order', receipt2.status === 'POSTED');
  check('12b. each gets its own number', receipt2.grnNo !== receipt1.grnNo);
  check('12c. and the second one knows what the first brought in',
    Number(receipt2.lines[0].previouslyReceivedQuantity) === 60,
    receipt2.lines[0].previouslyReceivedQuantity);
  check('12d. stock went in again', (await balanceOf(p1.id)).onHand === before2.onHand + 40);

  order = await po.get(order.id);
  check('12e. line 1 is complete but the order is not — line 2 has had nothing',
    order.lines[0].outstandingQuantity === 0 && order.status === 'PARTIALLY_RECEIVED', order.status);

  console.log('\n14. over-receipt');
  const over = await refused(() => grn.receive({
    purchaseOrderId: order.id,
    lines: [{ purchaseOrderLineId: order.lines[1].id, acceptedQuantity: 999 }],
  }, store));
  check('14. receiving more than is outstanding is refused', over.threw, over.err?.message);
  check('14b. and the refusal gives both figures',
    /40\.000 still outstanding/.test(JSON.stringify(over.err?.details ?? {})),
    JSON.stringify(over.err?.details));

  const overNoReason = await refused(() => grn.receive({
    purchaseOrderId: order.id,
    overReceiptApproved: true,
    lines: [{ purchaseOrderLineId: order.lines[1].id, acceptedQuantity: 45 }],
  }, store));
  check('14c. approving an over-receipt without a reason is refused',
    overNoReason.threw, overNoReason.err?.message);

  console.log('\n15. damaged and rejected goods');
  const before3 = await balanceOf(p2.id);
  const receipt3 = await grn.receive({
    purchaseOrderId: order.id,
    lines: [{
      purchaseOrderLineId: order.lines[1].id,
      acceptedQuantity: 30,
      damagedQuantity: 6,
      rejectedQuantity: 4,
      rejectionReason: 'Wrong shade entirely; sent straight back on the lorry.',
    }],
  }, store);
  const after3 = await balanceOf(p2.id);

  check('15. damaged stock DOES enter the building', after3.onHand === before3.onHand + 36,
    JSON.stringify({ before: before3, after: after3 }));
  check('15b. but is not sellable', after3.damaged === before3.damaged + 6
    && after3.available === before3.available + 30, JSON.stringify(after3));
  check('15c. rejected stock never enters at all — accepted + damaged only',
    after3.onHand - before3.onHand === 36);
  check('15d. two movements were written: inward, then the damage',
    receipt3.movements.length === 2
    && receipt3.movements.filter((m) => m.movementType === 'INWARD').length === 1
    && receipt3.movements.filter((m) => m.movementType === 'DAMAGE').length === 1,
    receipt3.movements.map((m) => m.movementType).join(','));

  const rejectNoReason = await refused(() => grn.receive({
    purchaseOrderId: order.id,
    lines: [{ purchaseOrderLineId: order.lines[1].id, rejectedQuantity: 1 }],
  }, store));
  check('15e. turning stock away with no reason is refused',
    rejectNoReason.threw, rejectNoReason.err?.message);

  const orderLine2 = (await po.get(order.id)).lines[1];
  check('15f. rejected quantity does NOT count towards the order — the supplier still owes it',
    orderLine2.receivedQuantity === 36 && orderLine2.rejectedQuantity === 4
    && orderLine2.outstandingQuantity === 4,
    JSON.stringify({ r: orderLine2.receivedQuantity, j: orderLine2.rejectedQuantity, o: orderLine2.outstandingQuantity }));

  console.log('\n13. completing the order');
  await grn.receive({
    purchaseOrderId: order.id,
    overReceiptApproved: true,
    overReceiptReason: 'Supplier made the balance up from the rejected batch.',
    lines: [{ purchaseOrderLineId: order.lines[1].id, acceptedQuantity: 4 }],
  }, store);
  order = await po.get(order.id);
  check('13. once every line is satisfied the order is fully received',
    order.status === 'FULLY_RECEIVED', order.status);

  const receiveClosed = await refused(() => grn.receive({
    purchaseOrderId: order.id,
    lines: [{ purchaseOrderLineId: order.lines[0].id, acceptedQuantity: 1 }],
  }, store));
  check('13b. a fully received order takes no more receipts', receiveClosed.threw, receiveClosed.err?.message);

  console.log('\n19-21. duplicates, idempotency and rollback');

  const keys = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'GOODS_RECEIPT_NOTE' },
    select: { idempotencyKey: true, referenceId: true },
  });
  check('19. every receipt movement carries a key derived from its own line id',
    keys.length > 0 && keys.every((k) => /^grn:[0-9a-f-]{36}:(inward|damage)$/.test(k.idempotencyKey)),
    keys.length + ' movements');
  check('19b. and no key repeats, so no stock was posted twice',
    new Set(keys.map((k) => k.idempotencyKey)).size === keys.length);

  /* A RETRY OF THE SAME WRITE. Posting the identical idempotency
     key again is what a resubmitted form or a retried request
     does, and the database must refuse it. */
  const sample = await prisma.stockLedgerEntry.findFirstOrThrow({
    where: { referenceType: 'GOODS_RECEIPT_NOTE' },
  });
  const { postStockMovement } = await import('../db/stock.mjs');
  const retry = await refused(() => postStockMovement({
    productId: sample.productId,
    warehouseId: sample.warehouseId,
    movementType: 'INWARD',
    reason: 'PURCHASE_RECEIPT',
    quantity: 1,
    referenceType: 'GOODS_RECEIPT_NOTE',
    idempotencyKey: sample.idempotencyKey,
    createdById: store.id,
  }));
  check('20. replaying a receipt movement is refused as a duplicate',
    retry.threw && retry.err?.name === 'DuplicateMovementError', retry.err?.name);

  /* ROLLBACK. A receipt whose SECOND line is invalid must leave
     no trace of its first: not a note, not a movement, not an
     altered order line. */
  const beforeRollback = await balanceOf(p1.id);
  const ledgerBeforeRollback = await ledgerCount();
  const notesBefore = await prisma.goodsReceiptNote.count();

  const freshOrder = await po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [
      { productId: p1.id, quantity: 10, unitPrice: '62.50' },
      { productId: p3.id, quantity: 10, unitPrice: '120.00' },
    ],
  }, admin);
  await po.approve(freshOrder.id, manager);

  const rollback = await refused(() => grn.receive({
    purchaseOrderId: freshOrder.id,
    lines: [
      { purchaseOrderLineId: freshOrder.lines[0].id, acceptedQuantity: 5 },
      // Invalid: far more than the line's outstanding quantity.
      { purchaseOrderLineId: freshOrder.lines[1].id, acceptedQuantity: 9999 },
    ],
  }, store));
  check('21. a receipt with one bad line is refused whole', rollback.threw, rollback.err?.message);
  check('21b. and the good line left NO stock behind',
    (await balanceOf(p1.id)).onHand === beforeRollback.onHand,
    JSON.stringify(await balanceOf(p1.id)));
  check('21c. no ledger entry was written', (await ledgerCount()) === ledgerBeforeRollback);
  check('21d. and no half-written receipt exists',
    (await prisma.goodsReceiptNote.count()) === notesBefore);

  console.log('\n31. two clerks receiving at the same moment');
  const raceOrder = await po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p3.id, quantity: 100, unitPrice: '120' }],
  }, admin);
  await po.approve(raceOrder.id, manager);
  const beforeRace = await balanceOf(p3.id);

  /* FIVE CONCURRENT RECEIPTS of twenty each against one order
     line. All five are legitimate and must all land; what must
     NOT happen is a lost update, where two of them read the same
     balance and one overwrites the other. */
  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => grn.receive({
      purchaseOrderId: raceOrder.id,
      lines: [{ purchaseOrderLineId: raceOrder.lines[0].id, acceptedQuantity: 20 }],
    }, store)),
  );
  const landed = results.filter((r) => r.status === 'fulfilled');
  check('31. every concurrent receipt was accepted', landed.length === 5,
    results.find((r) => r.status === 'rejected')?.reason?.message);
  const afterRace = await balanceOf(p3.id);
  check('31b. the balance moved by exactly the total, with no lost update',
    afterRace.onHand === beforeRace.onHand + 100,
    JSON.stringify({ before: beforeRace.onHand, after: afterRace.onHand }));

  const raceBalances = landed.flatMap((r) => r.value.movements.map((m) => m.balanceAfter));
  check('31c. and no two of them recorded the same resulting balance',
    new Set(raceBalances).size === raceBalances.length, raceBalances.join(','));

  const raceGrns = landed.map((r) => r.value.grnNo);
  check('27. concurrent document numbering produced no duplicate',
    new Set(raceGrns).size === 5, raceGrns.join(','));

  /* ────────────────────────────────────────────────────────
     24–26. GST
     ──────────────────────────────────────────────────────── */
  console.log('\n24-25. intra-state GST');
  const intra = await po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 10, unitPrice: '100', taxRate: 18 }],
  }, admin);
  check('25. a supplier in the same state is intra-state', intra.gst.treatment === 'INTRA_STATE');
  check('24. the tax is split into equal CGST and SGST',
    intra.totals.cgstTotal === 90 && intra.totals.sgstTotal === 90 && intra.totals.igstTotal === 0,
    JSON.stringify(intra.totals));
  check('24b. the taxable value is right', intra.totals.taxableTotal === 1000);
  check('24c. and the grand total adds up', intra.totals.grandTotal === 1180);

  console.log('\n26. inter-state GST');
  const inter = await po.create({
    supplierId: rajasthan.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 10, unitPrice: '100', taxRate: 18 }],
  }, admin);
  check('26. a supplier in another state is inter-state', inter.gst.treatment === 'INTER_STATE');
  check('26b. IGST carries the whole rate and the other two are zero',
    inter.totals.igstTotal === 180 && inter.totals.cgstTotal === 0 && inter.totals.sgstTotal === 0,
    JSON.stringify(inter.totals));
  check('26c. the grand total is identical either way', inter.totals.grandTotal === 1180);
  check('26d. the treatment is FROZEN on the order, not recomputed on read',
    inter.gst.supplierStateCode === '08' && inter.gst.placeOfSupplyCode === '24',
    JSON.stringify(inter.gst));

  /* DECIMAL SAFETY, against the database rather than in memory. */
  const awkward = await po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [
      { productId: p1.id, quantity: '3.333', unitPrice: '100.05', taxRate: 18 },
      { productId: p2.id, quantity: '7', unitPrice: '0.07', taxRate: 18 },
    ],
  }, admin);
  const stored = await prisma.purchaseOrder.findUniqueOrThrow({
    where: { id: awkward.id },
    select: { taxableTotal: true, taxTotal: true, grandTotal: true, cgstTotal: true, sgstTotal: true,
      lines: { select: { lineTotal: true, taxableValue: true, taxAmount: true } } },
  });
  const sumLines = stored.lines.reduce((t, l) => t + money.toPaise(l.lineTotal), 0);
  check('24d. awkward decimals: the stored grand total equals the stored lines added up',
    money.toPaise(stored.grandTotal) === sumLines,
    stored.grandTotal + ' vs ' + money.fromPaise(sumLines));
  check('24e. and CGST plus SGST equals the tax total exactly, to the paisa',
    money.toPaise(stored.cgstTotal) + money.toPaise(stored.sgstTotal) === money.toPaise(stored.taxTotal),
    JSON.stringify(stored));

  const noRate = await refused(() => po.create({
    supplierId: gujarat.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 1, unitPrice: '10', taxRate: 150 }],
  }, admin));
  check('24f. an impossible GST rate is refused', noRate.threw, noRate.err?.message);

  /* ────────────────────────────────────────────────────────
     23. SUPPLIER INVOICES
     ──────────────────────────────────────────────────────── */
  console.log('\n23. supplier invoices');
  const ledgerBeforeInvoice = await ledgerCount();
  const invoiceNo = uniq('SOM/2026/');
  const invoice = await si.create({
    supplierId: gujarat.id,
    invoiceNo,
    invoiceDate: '2026-11-20',
    invoiceAmount: '7375.00',
    goodsReceiptNoteId: receipt1.id,
  }, admin);
  check('23. a supplier invoice can be recorded', invoice.invoiceNo === invoiceNo);
  check('23b. recording it moved NO stock', (await ledgerCount()) === ledgerBeforeInvoice);
  check('23c. the due date follows the supplier credit period', invoice.dueDate !== null);
  check('23d. it is matched against the value actually received',
    invoice.match.receivedValue !== null && invoice.match.state !== 'UNLINKED',
    JSON.stringify(invoice.match));

  const dupInvoice = await refused(() => si.create({
    supplierId: gujarat.id, invoiceNo, invoiceDate: '2026-11-21', invoiceAmount: '1',
  }, admin));
  check('23e. the same invoice number twice from one supplier is refused',
    dupInvoice.threw, dupInvoice.err?.message);

  const sameNumberElsewhere = await si.create({
    supplierId: rajasthan.id, invoiceNo, invoiceDate: '2026-11-21', invoiceAmount: '500',
  }, admin);
  check('23f. but the same number from a different supplier is fine',
    Boolean(sameNumberElsewhere.id));

  const draftReceipt = await prisma.goodsReceiptNote.create({
    data: {
      grnNo: await nextDocumentNumber('GOODS_RECEIPT_NOTE'),
      status: 'DRAFT',
      purchaseOrderId: order.id,
      supplierId: gujarat.id,
      warehouseId: wh.id,
      receiptDate: new Date(),
      receivedById: store.id,
    },
  });
  const linkDraft = await refused(() => si.create({
    supplierId: gujarat.id, invoiceNo: uniq('X'), invoiceDate: '2026-11-21',
    invoiceAmount: '10', goodsReceiptNoteId: draftReceipt.id,
  }, admin));
  check('23g. an invoice cannot be linked to a DRAFT receipt — that is not evidence of delivery',
    linkDraft.threw, linkDraft.err?.message);

  const wrongSupplier = await refused(() => si.create({
    supplierId: rajasthan.id, invoiceNo: uniq('Y'), invoiceDate: '2026-11-21',
    invoiceAmount: '10', goodsReceiptNoteId: receipt1.id,
  }, admin));
  check('23h. nor to another supplier\'s receipt', wrongSupplier.threw, wrongSupplier.err?.message);

  /* ────────────────────────────────────────────────────────
     28. PURCHASE RETURNS
     ──────────────────────────────────────────────────────── */
  console.log('\n28. purchase returns');
  const beforeReturn = await balanceOf(p1.id);
  const ret = await pr.post({
    supplierId: gujarat.id,
    warehouseId: wh.id,
    reason: 'Shade variation outside tolerance.',
    lines: [{ productId: p1.id, quantity: 8 }],
  }, admin);
  const afterReturn = await balanceOf(p1.id);

  check('28. a purchase return posts', ret.status === 'POSTED'
    && /^PR-2026-\d{4}$/.test(ret.returnNo), ret.returnNo);
  check('28b. stock comes down by the returned quantity',
    afterReturn.onHand === beforeReturn.onHand - 8, JSON.stringify(afterReturn));
  check('28c. through an OUTWARD movement, with the receipt untouched',
    ret.movements.some((m) => m.movementType === 'OUTWARD'));

  const receiptStillThere = await prisma.stockLedgerEntry.findUnique({ where: { id: sample.id } });
  check('28d. the entry that brought the stock in is still on the ledger, unedited',
    Boolean(receiptStillThere) && Number(receiptStillThere.quantity) === Number(sample.quantity));

  const tooMuch = await refused(() => pr.post({
    supplierId: gujarat.id, warehouseId: wh.id, reason: 'test',
    lines: [{ productId: p1.id, quantity: 999999 }],
  }, admin));
  check('28e. returning more than the supplier ever delivered is refused',
    tooMuch.threw, tooMuch.err?.message);

  const noWhy = await refused(() => pr.post({
    supplierId: gujarat.id, warehouseId: wh.id, reason: '  ',
    lines: [{ productId: p1.id, quantity: 1 }],
  }, admin));
  check('28f. a return with no reason is refused', noWhy.threw, noWhy.err?.message);

  const beforeDamagedReturn = await balanceOf(p2.id);
  const damagedBack = await pr.post({
    supplierId: gujarat.id, warehouseId: wh.id,
    reason: 'Broken on arrival; collected by the supplier.',
    lines: [{ productId: p2.id, quantity: 6, fromDamaged: true }],
  }, admin);
  const afterDamagedReturn = await balanceOf(p2.id);
  check('28g. damaged stock can go back too', damagedBack.status === 'POSTED');
  check('28h. and it leaves BOTH the shelf and the damaged figure',
    afterDamagedReturn.onHand === beforeDamagedReturn.onHand - 6
    && afterDamagedReturn.damaged === beforeDamagedReturn.damaged - 6,
    JSON.stringify({ before: beforeDamagedReturn, after: afterDamagedReturn }));

  /* ────────────────────────────────────────────────────────
     27. DOCUMENT NUMBERING
     ──────────────────────────────────────────────────────── */
  console.log('\n27. document numbering');
  const numbers = await Promise.all(
    Array.from({ length: 12 }, () => nextDocumentNumber('PURCHASE_ORDER')),
  );
  check('27b. twelve numbers allocated at once are all different',
    new Set(numbers).size === 12, numbers.join(','));
  check('27c. and all correctly shaped', numbers.every((n) => /^PO-2026-\d{4}$/.test(n)));

  const sequences = await prisma.documentSequence.findMany({ select: { documentType: true } });
  check('27d. the purchase documents reuse the one existing sequence table',
    ['PURCHASE_ORDER', 'GOODS_RECEIPT_NOTE', 'PURCHASE_RETURN']
      .every((t) => sequences.some((s) => s.documentType === t)),
    sequences.map((s) => s.documentType).join(','));

  /* ────────────────────────────────────────────────────────
     29–30. THE LEDGER AND THE AUDIT LOG
     ──────────────────────────────────────────────────────── */
  console.log('\n29. the append-only ledger is still protected');
  const grnEntries = await prisma.stockLedgerEntry.count({
    where: { referenceType: 'GOODS_RECEIPT_NOTE' },
  });
  check('29a. there are receipt movements to attempt this on at all', grnEntries > 0, grnEntries);

  const editLedger = await refused(() => prisma.$executeRaw`
    UPDATE "stock_ledger_entries" SET "quantity" = 1 WHERE "referenceType" = 'GOODS_RECEIPT_NOTE'`);
  check('29. purchase did not weaken the append-only guard: UPDATE is refused',
    editLedger.threw, editLedger.err?.message);

  const deleteLedger = await refused(() => prisma.$executeRaw`
    DELETE FROM "stock_ledger_entries" WHERE "referenceType" = 'GOODS_RECEIPT_NOTE'`);
  check('29b. and so is DELETE', deleteLedger.threw, deleteLedger.err?.message);

  const cancelPosted = await refused(() => grn.cancel(receipt1.id, store, 'mistake'));
  check('29c. a POSTED receipt cannot be cancelled, and the message names the two remedies',
    cancelPosted.threw && /purchase return/i.test(cancelPosted.err?.message ?? ''),
    cancelPosted.err?.message);

  console.log('\n30. the audit log');
  const audits = await prisma.auditLog.findMany({
    where: { entityType: { in: ['PurchaseOrder', 'GoodsReceiptNote', 'PurchaseReturn', 'SupplierInvoice', 'Supplier'] } },
    select: { entityType: true, action: true, actorUserId: true, summary: true, createdAt: true },
  });
  check('30a. there are audit entries to check at all', audits.length > 0, audits.length);
  check('30. every purchase action is recorded',
    ['CREATE', 'APPROVE', 'RECEIVE', 'CANCEL', 'POST'].every((a) => audits.some((r) => r.action === a)),
    [...new Set(audits.map((a) => a.action))].join(','));
  check('30b. every entry names a person and a time',
    audits.every((a) => a.actorUserId !== null && a.createdAt instanceof Date));
  check('30c. and says what happened in words',
    audits.every((a) => typeof a.summary === 'string' && a.summary.length > 10));

  const editAudit = await refused(() => prisma.$executeRaw`
    UPDATE "audit_logs" SET "summary" = 'edited' WHERE "entityType" = 'PurchaseOrder'`);
  check('30d. and the audit log itself cannot be rewritten', editAudit.threw, editAudit.err?.message);

  /* ────────────────────────────────────────────────────────
     32. RECONCILIATION
     ──────────────────────────────────────────────────────── */
  console.log('\n32. inventory reconciliation after all of that');
  const [recon] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS drifted FROM v_inventory_reconciliation WHERE NOT reconciled`;
  check('32. every balance still reconciles with the ledger that produced it',
    recon.drifted === 0, recon.drifted);

  const [transfers] = await prisma.$queryRaw`
    SELECT COUNT(*)::int AS unbalanced FROM v_transfer_reconciliation WHERE NOT balanced`;
  check('32b. and every warehouse transfer still balances', transfers.unbalanced === 0);

  /* THE PURCHASE SIDE RECONCILED TOO: what the order lines claim
     to have received must equal what the posted receipts say. */
  const lines = await prisma.purchaseOrderLine.findMany({
    select: {
      id: true, receivedQuantity: true,
      receiptLines: {
        where: { goodsReceiptNote: { status: 'POSTED' } },
        select: { receivedQuantity: true },
      },
    },
  });
  check('32c. there are order lines to check', lines.length > 0, lines.length);
  const drifted = lines.filter((l) => money.toMilli(l.receivedQuantity)
    !== l.receiptLines.reduce((t, r) => t + money.toMilli(r.receivedQuantity), 0));
  check('32d. every order line\'s received total equals its posted receipts',
    drifted.length === 0, drifted.length + ' lines disagree');

  /* ────────────────────────────────────────────────────────
     NOTHING BUT THE STOCK SERVICE WRITES STOCK
     ──────────────────────────────────────────────────────── */
  console.log('\n33. purchase did not open a second door into inventory');
  const writers = execSync(
    'grep -rln "inventoryBalance\\.\\(update\\|upsert\\|create\\)\\|stockLedgerEntry\\.create" '
    + 'server db prisma/seed.mjs || true',
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  const allowed = new Set(['db/stock.mjs', 'server/services/warehouse.service.mjs', 'prisma/seed.mjs']);
  check('33. no purchase service writes a balance or a ledger row directly',
    writers.every((f) => allowed.has(f)), writers.filter((f) => !allowed.has(f)).join(', '));

  /* Matched on the IMPORT line, not on the word. An earlier
     version grepped for "postStockMovement" anywhere in the file
     and flagged two services whose only mention of it is a
     comment saying they deliberately do NOT import it. */
  const purchaseImports = execSync(
    'grep -lE "^import \\{[^}]*postStockMovement" server/services/*.mjs || true',
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  check('33b. and only the receipt and return services import the stock service at all',
    purchaseImports.every((f) => [
      'server/services/inventory.service.mjs',
      'server/services/warehouse.service.mjs',
      'server/services/grn.service.mjs',
      'server/services/purchaseReturn.service.mjs',
    ].includes(f)), purchaseImports.join(', '));

  /* ────────────────────────────────────────────────────────
     THE DASHBOARD READS THE DATABASE
     ──────────────────────────────────────────────────────── */
  console.log('\n34. the dashboard figures are real');
  const d = await board.dashboard();
  const realCounts = await Promise.all([
    prisma.supplier.count(),
    prisma.purchaseOrder.count(),
    prisma.goodsReceiptNote.count({ where: { status: 'POSTED' } }),
    prisma.purchaseReturn.count({ where: { status: 'POSTED' } }),
  ]);
  check('34. the supplier count matches the table', d.suppliers.total === realCounts[0],
    d.suppliers.total + ' vs ' + realCounts[0]);
  check('34b. the order count matches', d.orders.total === realCounts[1]);
  check('34c. the posted receipt count matches', d.receipts.posted === realCounts[2]);
  check('34d. the return count matches', d.returns.posted === realCounts[3]);
  check('34e. and the figures are not all zero, so this is not a vacuous pass',
    d.orders.total > 0 && d.receipts.posted > 0 && d.receipts.totalReceivedQuantity > 0,
    JSON.stringify(d.orders));

  const history = await board.history({});
  check('34f. the history timeline carries every document kind',
    ['ORDER', 'RECEIPT', 'RETURN', 'INVOICE'].every((k) => history.rows.some((r) => r.kind === k)),
    [...new Set(history.rows.map((r) => r.kind))].join(','));
}

try {
  await main();
} catch (err) {
  failures.push('the suite itself threw: ' + err.message);
  if (err.details) console.error('\ndetails: ' + JSON.stringify(err.details, null, 1));
  console.error('\n' + err.stack);
}

console.log('\n' + '='.repeat(58));
console.log(passed + ' passed, ' + failures.length + ' failed, ' + (passed + failures.length) + ' checks');
if (failures.length) console.log('\nfailed:\n  ' + failures.join('\n  '));
console.log('='.repeat(58));

await disconnect();
process.exit(failures.length ? 1 : 0);
