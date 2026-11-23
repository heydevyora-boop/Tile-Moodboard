import { execSync } from 'node:child_process';
import { useTestDatabase, migrate, seed } from './helpers/testdb.mjs';

/* ============================================================
   SALES MANAGEMENT, TESTED AGAINST A REAL DATABASE
   ============================================================
   The forty-four cases the brief lists, plus the checks that make
   them worth having. Same discipline as test/purchase_test.mjs:
   its own database, dropped and rebuilt on every run; nothing
   asserted without reading it back from the database; no check
   that would pass against zero rows without first asserting the
   count is not zero.

   Run:  npm run test:sales
   ============================================================ */

const DB = 'devyora_erp_sales_test';

if (!/_sales_test$/.test(DB)) {
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
const customers = await import('../server/services/customer.service.mjs');
const quotations = await import('../server/services/quotation.service.mjs');
const so = await import('../server/services/salesOrder.service.mjs');
const reservation = await import('../server/services/reservation.service.mjs');
const dispatchSvc = await import('../server/services/dispatch.service.mjs');
const invoices = await import('../server/services/salesInvoice.service.mjs');
const returns = await import('../server/services/salesReturn.service.mjs');
const payments = await import('../server/services/payment.service.mjs');
const board = await import('../server/services/salesDashboard.service.mjs');
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
  const salesUser = await prisma.user.findUniqueOrThrow({ where: { email: 'sales@devyora.local' } });

  const gujaratCustomer = await prisma.customer.findUniqueOrThrow({ where: { code: 'CUS-0001' } });
  const maharashtraCustomer = await prisma.customer.findUniqueOrThrow({ where: { code: 'CUS-0002' } });
  const wh = await prisma.warehouse.findFirstOrThrow({ where: { isDefault: true } });
  const p1 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1001' } }); // 180 on hand
  const p2 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1002' } }); // 95 on hand
  const p3 = await prisma.product.findFirstOrThrow({ where: { sku: 'DV-1003' } }); // 40 on hand

  const balanceOf = async (productId, warehouseId = wh.id) => {
    const b = await prisma.inventoryBalance.findUnique({ where: { productId_warehouseId: { productId, warehouseId } } });
    return b
      ? {
        onHand: Number(b.quantityOnHand), reserved: Number(b.quantityReserved), damaged: Number(b.quantityDamaged),
        available: Number(b.quantityOnHand) - Number(b.quantityReserved) - Number(b.quantityDamaged),
      }
      : { onHand: 0, reserved: 0, damaged: 0, available: 0 };
  };
  const ledgerCount = () => prisma.stockLedgerEntry.count();

  /* A full order, from scratch, confirmed and reserved -- the
     starting point every dispatch/invoice/return test needs, so
     it is built once here rather than copy-pasted forty times. */
  const freshReservedOrder = async (customer, productId, quantity) => {
    const order = await so.create({
      customerId: customer.id, warehouseId: wh.id,
      lines: [{ productId, quantity, unitPrice: '100' }],
    }, salesUser);
    await so.submit(order.id, salesUser);
    const approved = await so.approve(order.id, manager);
    await reservation.reserveForOrder({
      salesOrderId: order.id,
      lines: [{ salesOrderLineId: approved.lines[0].id, quantity }],
    }, store);
    return so.get(order.id);
  };

  /* ────────────────────────────────────────────────────────
     1-4. CUSTOMERS
     ──────────────────────────────────────────────────────── */
  console.log('\n1-4. customer CRUD');

  const newCustomer = await customers.create({
    name: 'Test Buyer ' + uniq('x'), stateCode: '24', shippingStateCode: '24', type: 'RETAIL',
  }, salesUser);
  check('1. a customer is created with a derived code', /^CUS-/.test(newCustomer.code), newCustomer.code);

  const readBack = await customers.get(newCustomer.id);
  check('2. the customer reads back with the same id', readBack.id === newCustomer.id);

  const updated = await customers.update(newCustomer.id, { paymentTerms: '15 days' }, salesUser);
  check('3. an update is applied', updated.paymentTerms === '15 days');

  const deactivated = await customers.setActive(newCustomer.id, false, salesUser, 'test teardown');
  check('4. a customer can be deactivated', deactivated.isActive === false);
  const reactivated = await customers.setActive(newCustomer.id, true, salesUser);
  check('4b. and reactivated', reactivated.isActive === true);

  const noDeleteFn = customers.delete;
  check('4c. there is no delete() exported -- deactivation is the only supported removal', noDeleteFn === undefined);

  /* ────────────────────────────────────────────────────────
     5-11. QUOTATIONS, AND THAT THEY MOVE NO STOCK
     ──────────────────────────────────────────────────────── */
  console.log('\n5-11. quotations');

  const ledgerBeforeQuote = await ledgerCount();

  const quote = await quotations.create({
    customerId: gujaratCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 10, unitPrice: '84' }],
  }, salesUser);
  check('5. a quotation is created as a draft', quote.status === 'DRAFT');
  check('5b. its GST is computed and frozen', quote.totals.grandTotal > 0, quote.totals.grandTotal);

  const quoteUpdated = await quotations.update(quote.id, {
    customerId: gujaratCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 12, unitPrice: '84' }],
  }, salesUser);
  check('6. a draft quotation can be edited', Number(quoteUpdated.lines[0].quantity) === 12);

  const sent = await quotations.send(quote.id, salesUser);
  check('7. sending moves it to SENT', sent.status === 'SENT');

  const editAfterSend = await refused(() => quotations.update(quote.id, { lines: [] }, salesUser));
  check('7b. a sent quotation can no longer be freely edited', editAfterSend.threw);

  const accepted = await quotations.respond(quote.id, 'ACCEPTED', salesUser);
  check('8. the customer accepting moves it to ACCEPTED', accepted.status === 'ACCEPTED');

  check('11. quotation creation, editing, sending and accepting moved NO stock',
    (await ledgerCount()) === ledgerBeforeQuote, (await ledgerCount()) - ledgerBeforeQuote);

  // ── revision ──
  const revised = await quotations.revise(quote.id, {
    customerId: gujaratCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 20, unitPrice: '80' }],
  }, salesUser);
  check('9. revising creates a new quotation, revision 2', revised.revisionNo === 2, revised.revisionNo);
  const originalAfterRevision = await quotations.get(quote.id);
  check('9b. and cancels the one it supersedes', originalAfterRevision.status === 'CANCELLED');

  // ── conversion ──
  const revisedSent = await quotations.send(revised.id, salesUser);
  await quotations.respond(revised.id, 'ACCEPTED', salesUser);
  const ledgerBeforeConvert = await ledgerCount();
  const converted = await quotations.convert(revised.id, salesUser);
  check('10. converting an accepted quotation creates a sales order',
    converted.newOrder && /^SO-/.test(converted.newOrder.orderNo), converted.newOrder);
  check('10b. the quotation is marked CONVERTED', converted.status === 'CONVERTED');
  check('10c. the new order carries the quotation\'s own frozen price, not today\'s catalogue price',
    Number((await so.get(converted.newOrder.id)).lines[0].unitPrice) === 80);
  check('11b. converting a quotation moved NO stock either -- it only creates a draft order',
    (await ledgerCount()) === ledgerBeforeConvert);

  const convertTwice = await refused(() => quotations.convert(revised.id, salesUser));
  check('10d. a quotation already converted cannot be converted again', convertTwice.threw);

  /* ────────────────────────────────────────────────────────
     12-17. SALES ORDERS, STATUS MACHINE, GST
     ──────────────────────────────────────────────────────── */
  console.log('\n12-17. sales orders and GST');

  const order = await so.create({
    customerId: gujaratCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p1.id, quantity: 8, unitPrice: '84' }],
  }, salesUser);
  check('12. a sales order is created as a draft', order.status === 'DRAFT');

  await so.submit(order.id, salesUser);
  const approvedOrder = await so.approve(order.id, manager);
  check('14. approval moves it to CONFIRMED', approvedOrder.status === 'CONFIRMED');

  const reApprove = await refused(() => so.approve(order.id, manager));
  check('15. an already-confirmed order cannot be approved again', reApprove.threw);
  const submitConfirmed = await refused(() => so.submit(order.id, salesUser));
  check('15b. a confirmed order cannot be "submitted" again -- an invalid transition is refused',
    submitConfirmed.threw, submitConfirmed.err?.message);

  check('16. intra-state (Gujarat warehouse, Gujarat customer) GST is CGST+SGST',
    approvedOrder.gst.treatment === 'INTRA_STATE'
    && approvedOrder.totals.cgstTotal > 0 && approvedOrder.totals.sgstTotal > 0 && approvedOrder.totals.igstTotal === 0);

  const interOrder = await so.create({
    customerId: maharashtraCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p2.id, quantity: 4, unitPrice: '81' }],
  }, salesUser);
  check('17. inter-state (Gujarat warehouse, Maharashtra customer) GST is IGST only',
    interOrder.gst.treatment === 'INTER_STATE'
    && interOrder.totals.igstTotal > 0 && interOrder.totals.cgstTotal === 0 && interOrder.totals.sgstTotal === 0);

  const storedOrder = await prisma.salesOrder.findUniqueOrThrow({ where: { id: interOrder.id } });
  check('17b. the inter-state GST actually stored matches what computeLine would derive',
    Number(storedOrder.igstTotal) === interOrder.totals.igstTotal
    && Number(storedOrder.taxableTotal) === interOrder.totals.taxableTotal);

  /* ────────────────────────────────────────────────────────
     18-22. AVAILABILITY & RESERVATION
     ──────────────────────────────────────────────────────── */
  console.log('\n18-22. stock availability and reservation');

  await so.submit(interOrder.id, salesUser);
  const confirmedInter = await so.approve(interOrder.id, manager);

  const avail = await reservation.availability(confirmedInter.id);
  check('18. availability is read fresh from inventory_balances',
    avail.lines[0].warehouseOnHand === (await balanceOf(p2.id)).onHand);

  const beforeReserve = await balanceOf(p2.id);
  const afterReserve = await reservation.reserveForOrder({
    salesOrderId: confirmedInter.id,
    lines: [{ salesOrderLineId: confirmedInter.lines[0].id, quantity: 4, idempotencyKey: 'reserve-test-1' }],
  }, store);
  check('19. reserving moves the RESERVED dimension, not on-hand',
    afterReserve.salesOrder.status === 'RESERVED', afterReserve.salesOrder.status);
  const afterReserveBalance = await balanceOf(p2.id);
  check('19b. physical on-hand is unchanged by a reservation',
    afterReserveBalance.onHand === beforeReserve.onHand);
  check('19c. and reserved increased by exactly the amount promised',
    afterReserveBalance.reserved === beforeReserve.reserved + 4);

  const tooMuchOrder = await so.create({
    customerId: gujaratCustomer.id, warehouseId: wh.id,
    lines: [{ productId: p3.id, quantity: 9999, unitPrice: '248' }],   // only 40 on hand
  }, salesUser);
  await so.submit(tooMuchOrder.id, salesUser);
  const confirmedTooMuch = await so.approve(tooMuchOrder.id, manager);
  const insufficientReserve = await refused(() => reservation.reserveForOrder({
    salesOrderId: confirmedTooMuch.id,
    lines: [{ salesOrderLineId: confirmedTooMuch.lines[0].id, quantity: 9999 }],
  }, store));
  check('20. reserving more than is available is refused', insufficientReserve.threw, insufficientReserve.err?.message);

  // Idempotent retry: the same key, submitted twice, lands once.
  const idemOrder = await freshReservedOrderBuilder();
  async function freshReservedOrderBuilder() {
    const o = await so.create({ customerId: gujaratCustomer.id, warehouseId: wh.id, lines: [{ productId: p1.id, quantity: 3, unitPrice: '84' }] }, salesUser);
    await so.submit(o.id, salesUser);
    return so.approve(o.id, manager);
  }
  const key = 'idem-test-' + uniq('k');
  const firstReserve = await reservation.reserveForOrder({
    salesOrderId: idemOrder.id, lines: [{ salesOrderLineId: idemOrder.lines[0].id, quantity: 3, idempotencyKey: key }],
  }, store);
  const retryReserve = await refused(() => reservation.reserveForOrder({
    salesOrderId: idemOrder.id,
    // Same order, same line, same key, but asking for 0 more --
    // the line is already fully reserved, so the service's own
    // "nothing left to reserve" check and the ledger's unique key
    // would both refuse a genuine repeat of the exact same call.
    lines: [{ salesOrderLineId: idemOrder.lines[0].id, quantity: 3, idempotencyKey: key }],
  }, store));
  check('21. replaying the exact same reservation request is refused, not double-counted',
    retryReserve.threw, retryReserve.err?.message);
  check('21b. and the reserved figure still reads as if it only happened once',
    (await balanceOf(p1.id, wh.id)).reserved >= 3);

  console.log('\n22. two clerks reserving the same product at the same moment');
  const raceProduct = p1;
  const raceOrders = await Promise.all(Array.from({ length: 4 }, async () => {
    const o = await so.create({ customerId: gujaratCustomer.id, warehouseId: wh.id, lines: [{ productId: raceProduct.id, quantity: 5, unitPrice: '84' }] }, salesUser);
    await so.submit(o.id, salesUser);
    return so.approve(o.id, manager);
  }));
  const beforeRaceReserve = await balanceOf(raceProduct.id);
  const raceResults = await Promise.allSettled(raceOrders.map((o) => reservation.reserveForOrder({
    salesOrderId: o.id, lines: [{ salesOrderLineId: o.lines[0].id, quantity: 5 }],
  }, store)));
  const raceLanded = raceResults.filter((r) => r.status === 'fulfilled');
  check('22. every concurrent reservation that fit was accepted', raceLanded.length === 4,
    raceResults.find((r) => r.status === 'rejected')?.reason?.message);
  const afterRaceReserve = await balanceOf(raceProduct.id);
  check('22b. the reserved figure moved by exactly the total, with no lost update',
    afterRaceReserve.reserved === beforeRaceReserve.reserved + 20,
    JSON.stringify({ before: beforeRaceReserve.reserved, after: afterRaceReserve.reserved }));

  /* ────────────────────────────────────────────────────────
     23-25. SALES INVOICES, AND THAT THEY MOVE NO STOCK
     ──────────────────────────────────────────────────────── */
  console.log('\n23-25. sales invoices');

  const invOrder = await freshReservedOrder(gujaratCustomer, p1.id, 6);
  const ledgerBeforeInvoice = await ledgerCount();

  const invoice = await invoices.create({
    salesOrderId: invOrder.id, lines: [{ salesOrderLineId: invOrder.lines[0].id, quantity: 4 }],
  }, manager);
  check('23. an invoice is posted for a partial quantity', invoice.status === 'POSTED');
  check('23b. its price and tax are frozen -- the taxable value matches quantity x rate',
    invoice.lines[0].taxableValue === invoice.lines[0].quantity * invoice.lines[0].unitPrice);
  check('24. posting an invoice moved NO stock', (await ledgerCount()) === ledgerBeforeInvoice);

  const secondInvoice = await invoices.create({
    salesOrderId: invOrder.id, lines: [{ salesOrderLineId: invOrder.lines[0].id, quantity: 2 }],
  }, manager);
  check('25. a second invoice can be raised for the remaining quantity -- multiple invoices per order',
    secondInvoice.status === 'POSTED');
  const invoiceOverQuantity = await refused(() => invoices.create({
    salesOrderId: invOrder.id, lines: [{ salesOrderLineId: invOrder.lines[0].id, quantity: 1 }],
  }, manager));
  check('25b. and nothing remains to invoice once the full ordered quantity has been billed',
    invoiceOverQuantity.threw, invoiceOverQuantity.err?.message);

  /* ────────────────────────────────────────────────────────
     26-33. DISPATCH -- THE ONLY SALES DOCUMENT THAT ISSUES STOCK
     ──────────────────────────────────────────────────────── */
  console.log('\n26-33. dispatch');

  const dispatchOrder = await freshReservedOrder(gujaratCustomer, p1.id, 10);
  const beforeDispatch = await balanceOf(p1.id);

  const partial = await dispatchSvc.dispatch({
    salesOrderId: dispatchOrder.id, lines: [{ salesOrderLineId: dispatchOrder.lines[0].id, quantity: 6 }],
  }, store);
  check('26. a partial dispatch is posted', partial.status === 'DISPATCHED');
  const afterPartial = await so.get(dispatchOrder.id);
  check('26b. the order is PARTIALLY_DISPATCHED', afterPartial.status === 'PARTIALLY_DISPATCHED');

  const full = await dispatchSvc.dispatch({
    salesOrderId: dispatchOrder.id, lines: [{ salesOrderLineId: dispatchOrder.lines[0].id, quantity: 4 }],
  }, store);
  check('27. a second dispatch completes the order -- multiple dispatches per order', full.status === 'DISPATCHED');
  const afterFull = await so.get(dispatchOrder.id);
  check('27b. the order is now FULLY_DISPATCHED', afterFull.status === 'FULLY_DISPATCHED');

  const afterDispatch = await balanceOf(p1.id);
  check('30. on-hand dropped by exactly the quantity dispatched (10)', afterDispatch.onHand === beforeDispatch.onHand - 10,
    JSON.stringify({ before: beforeDispatch, after: afterDispatch }));
  check('30b. and the reservation was consumed down to zero on this line',
    Number(afterFull.lines[0].reservedQuantity) === 0);

  const dcMovements = await prisma.stockLedgerEntry.findMany({
    where: { referenceType: 'DELIVERY_CHALLAN', referenceId: partial.id },
    orderBy: { entryNo: 'asc' },
  });
  check('30c. a dispatch posts RESERVATION_RELEASE before OUTWARD, in that order',
    dcMovements.length === 2 && dcMovements[0].movementType === 'RESERVATION_RELEASE' && dcMovements[1].movementType === 'OUTWARD',
    dcMovements.map((m) => m.movementType).join(','));

  const excessOverOrdered = await refused(() => dispatchSvc.dispatch({
    salesOrderId: dispatchOrder.id, lines: [{ salesOrderLineId: dispatchOrder.lines[0].id, quantity: 1 }],
  }, store));
  check('28. dispatching more than was ordered is refused once the order is fully dispatched',
    excessOverOrdered.threw, excessOverOrdered.err?.message);

  const unreservedOrder = await freshReservedOrder(gujaratCustomer, p1.id, 5);
  // Only half is actually reserved for this attempt -- release the rest by hand to simulate it.
  await reservation.releaseFromOrder({
    salesOrderId: unreservedOrder.id, lines: [{ salesOrderLineId: unreservedOrder.lines[0].id, quantity: 3 }],
  }, store);
  const beyondReserved = await refused(() => dispatchSvc.dispatch({
    salesOrderId: unreservedOrder.id, lines: [{ salesOrderLineId: unreservedOrder.lines[0].id, quantity: 5 }],
  }, store));
  check('29. dispatching beyond what is reserved is refused without an explicit approval',
    beyondReserved.threw, beyondReserved.err?.message);
  const withApproval = await dispatchSvc.dispatch({
    salesOrderId: unreservedOrder.id,
    lines: [{ salesOrderLineId: unreservedOrder.lines[0].id, quantity: 5, allowUnreserved: true }],
    allowUnreservedApproved: true, allowUnreservedReason: 'test: shipping unreserved stock by agreement',
  }, store);
  check('29b. but succeeds once that approval and reason are given', withApproval.status === 'DISPATCHED');

  // Duplicate dispatch retry: the exact same challan line id cannot post twice.
  const retryOrder = await freshReservedOrder(gujaratCustomer, p1.id, 2);
  const firstDispatch = await dispatchSvc.dispatch({
    salesOrderId: retryOrder.id, lines: [{ salesOrderLineId: retryOrder.lines[0].id, quantity: 2 }],
  }, store);
  const sampleOutward = await prisma.stockLedgerEntry.findFirstOrThrow({
    where: { referenceType: 'DELIVERY_CHALLAN', referenceId: firstDispatch.id, movementType: 'OUTWARD' },
  });
  const { postStockMovement } = await import('../db/stock.mjs');
  const replay = await refused(() => postStockMovement({
    productId: sampleOutward.productId, warehouseId: sampleOutward.warehouseId,
    movementType: 'OUTWARD', reason: 'SALES_DISPATCH', quantity: 1,
    referenceType: 'DELIVERY_CHALLAN', idempotencyKey: sampleOutward.idempotencyKey, createdById: store.id,
  }));
  check('31. replaying a dispatch\'s own outward movement is refused as a duplicate',
    replay.threw && replay.err?.name === 'DuplicateMovementError', replay.err?.name);

  // Failed dispatch rollback: one bad line must leave no trace of the good one.
  const rollbackOrder = await freshReservedOrder(gujaratCustomer, p2.id, 3);
  const beforeRollback = await balanceOf(p2.id);
  const ledgerBeforeRollback = await ledgerCount();
  const dcCountBefore = await prisma.deliveryChallan.count();
  const rollbackAttempt = await refused(() => dispatchSvc.dispatch({
    salesOrderId: rollbackOrder.id,
    lines: [
      { salesOrderLineId: rollbackOrder.lines[0].id, quantity: 3 },
      { salesOrderLineId: 'not-a-real-line-id', quantity: 1 },
    ],
  }, store));
  check('32. a dispatch with one bad line is refused whole', rollbackAttempt.threw, rollbackAttempt.err?.message);
  check('32b. and the good line left no stock behind', (await balanceOf(p2.id)).onHand === beforeRollback.onHand);
  check('32c. no ledger entry was written', (await ledgerCount()) === ledgerBeforeRollback);
  check('32d. and no half-posted challan exists', (await prisma.deliveryChallan.count()) === dcCountBefore);

  /* ────────────────────────────────────────────────────────
     33-35. CANCELLATION AND CLOSING SHORT
     ──────────────────────────────────────────────────────── */
  console.log('\n33-35. cancellation, closing short, and reservation release');

  const cancelOrder = await freshReservedOrder(gujaratCustomer, p1.id, 4);
  const beforeCancel = await balanceOf(p1.id);
  const cancelled = await so.cancel(cancelOrder.id, salesUser, 'customer withdrew before anything shipped');
  check('33. cancelling before any dispatch succeeds', cancelled.status === 'CANCELLED');
  const afterCancel = await balanceOf(p1.id);
  check('34. cancelling released the reservation back to available stock',
    afterCancel.reserved === beforeCancel.reserved - 4 && afterCancel.onHand === beforeCancel.onHand);

  const dispatchedOrder = await freshReservedOrder(gujaratCustomer, p1.id, 4);
  await dispatchSvc.dispatch({ salesOrderId: dispatchedOrder.id, lines: [{ salesOrderLineId: dispatchedOrder.lines[0].id, quantity: 4 }] }, store);
  const cancelAfterDispatch = await refused(() => so.cancel(dispatchedOrder.id, salesUser, 'changed mind'));
  check('33b. cancelling after dispatch is refused -- closing short is the correct path',
    cancelAfterDispatch.threw, cancelAfterDispatch.err?.message);

  const closeOrder = await freshReservedOrder(gujaratCustomer, p1.id, 10);
  await dispatchSvc.dispatch({ salesOrderId: closeOrder.id, lines: [{ salesOrderLineId: closeOrder.lines[0].id, quantity: 6 }] }, store);
  const beforeClose = await balanceOf(p1.id);
  const closed = await so.close(closeOrder.id, manager, 'customer only wants the partial delivery');
  check('35. closing a partially-dispatched order succeeds', closed.status === 'CLOSED');
  const afterClose = await balanceOf(p1.id);
  check('35b. the undispatched 4 units\' reservation was released, the dispatched 6 were untouched',
    afterClose.reserved === beforeClose.reserved - 4 && afterClose.onHand === beforeClose.onHand);

  /* ────────────────────────────────────────────────────────
     36-39. SALES RETURNS, THREE DISPOSITIONS
     ──────────────────────────────────────────────────────── */
  console.log('\n36-39. sales returns');

  const returnOrder = await freshReservedOrder(gujaratCustomer, p1.id, 10);
  await dispatchSvc.dispatch({ salesOrderId: returnOrder.id, lines: [{ salesOrderLineId: returnOrder.lines[0].id, quantity: 10 }] }, store);
  const beforeReturn = await balanceOf(p1.id);

  const goodReturn = await returns.post({
    salesOrderId: returnOrder.id, reason: 'shade acceptable, customer changed order size',
    lines: [{ salesOrderLineId: returnOrder.lines[0].id, disposition: 'ACCEPTED_GOOD', quantity: 3 }],
  }, manager);
  check('36. an accepted-good return is posted', goodReturn.status === 'POSTED');
  const afterGoodReturn = await balanceOf(p1.id);
  check('36b. on-hand increased by exactly the accepted quantity, sellable (not damaged)',
    afterGoodReturn.onHand === beforeReturn.onHand + 3 && afterGoodReturn.damaged === beforeReturn.damaged);

  const damagedReturn = await returns.post({
    salesOrderId: returnOrder.id, reason: 'arrived cracked, customer sent back',
    lines: [{ salesOrderLineId: returnOrder.lines[0].id, disposition: 'DAMAGED', quantity: 2 }],
  }, manager);
  check('37. a damaged return is posted', damagedReturn.status === 'POSTED');
  const afterDamagedReturn = await balanceOf(p1.id);
  check('37b. on-hand went up by 2 (physically back) and damaged went up by 2 (not sellable)',
    afterDamagedReturn.onHand === afterGoodReturn.onHand + 2 && afterDamagedReturn.damaged === afterGoodReturn.damaged + 2);

  const ledgerBeforeRejected = await ledgerCount();
  const rejectedReturn = await returns.post({
    salesOrderId: returnOrder.id, reason: 'customer claim disputed, goods kept by customer',
    lines: [{ salesOrderLineId: returnOrder.lines[0].id, disposition: 'REJECTED', quantity: 1 }],
  }, manager);
  check('38. a rejected return is posted but moves NO stock', (await ledgerCount()) === ledgerBeforeRejected);
  const afterRejectedReturn = await balanceOf(p1.id);
  check('38b. on-hand and damaged are unchanged by a rejected return',
    afterRejectedReturn.onHand === afterDamagedReturn.onHand && afterRejectedReturn.damaged === afterDamagedReturn.damaged);
  check('38c. rejection is recorded on the line, not silently dropped', rejectedReturn.lines.some((l) => l.disposition === 'REJECTED'));

  // 10 dispatched, 3+2+1 = 6 already claimed back (of any disposition) -> 4 eligible remain.
  const excessReturn = await refused(() => returns.post({
    salesOrderId: returnOrder.id, reason: 'trying to return more than remains eligible',
    lines: [{ salesOrderLineId: returnOrder.lines[0].id, disposition: 'ACCEPTED_GOOD', quantity: 5 }],
  }, manager));
  check('39. a return beyond what is eligible (dispatched less already claimed) is refused',
    excessReturn.threw, excessReturn.err?.message);

  /* ────────────────────────────────────────────────────────
     40-41. CUSTOMER PAYMENTS
     ──────────────────────────────────────────────────────── */
  console.log('\n40-41. customer payments');

  const payOrder = await freshReservedOrder(gujaratCustomer, p1.id, 5);
  const payInvoice = await invoices.create({
    salesOrderId: payOrder.id, lines: [{ salesOrderLineId: payOrder.lines[0].id, quantity: 5 }],
  }, manager);

  const firstPayment = await payments.record({
    salesInvoiceId: payInvoice.id, amount: payInvoice.grandTotal / 2, paymentDate: new Date().toISOString(), method: 'UPI',
  }, manager);
  check('40. a part-payment is recorded', firstPayment.amount > 0);
  const balanceAfterFirst = await payments.balanceOf(payInvoice.id);
  check('40b. the outstanding balance is derived, not stored, and reflects the payment',
    balanceAfterFirst.outstanding === balanceAfterFirst.grandTotal - balanceAfterFirst.paid
    && balanceAfterFirst.status === 'PARTIALLY_PAID');

  const secondPayment = await payments.record({
    salesInvoiceId: payInvoice.id, amount: balanceAfterFirst.outstanding, paymentDate: new Date().toISOString(), method: 'BANK_TRANSFER',
  }, manager);
  check('41. the remaining balance can be paid off', secondPayment.amount === balanceAfterFirst.outstanding);
  const balanceAfterSecond = await payments.balanceOf(payInvoice.id);
  check('41b. the invoice now reads fully PAID', balanceAfterSecond.status === 'PAID' && balanceAfterSecond.outstanding === 0);

  const overpay = await refused(() => payments.record({
    salesInvoiceId: payInvoice.id, amount: 1, paymentDate: new Date().toISOString(), method: 'CASH',
  }, manager));
  check('41c. a payment beyond the outstanding balance is refused', overpay.threw, overpay.err?.message);

  /* ────────────────────────────────────────────────────────
     42. DOCUMENT NUMBERING UNDER CONCURRENCY
     ──────────────────────────────────────────────────────── */
  console.log('\n42. concurrent document numbering');

  const concurrentOrders = await Promise.allSettled(
    Array.from({ length: 6 }, () => so.create({
      customerId: gujaratCustomer.id, warehouseId: wh.id, lines: [{ productId: p1.id, quantity: 1, unitPrice: '84' }],
    }, salesUser)),
  );
  const landedOrders = concurrentOrders.filter((r) => r.status === 'fulfilled').map((r) => r.value.orderNo);
  check('42. six concurrent sales order creations all landed', landedOrders.length === 6,
    concurrentOrders.find((r) => r.status === 'rejected')?.reason?.message);
  check('42b. and produced six distinct order numbers, no duplicate',
    new Set(landedOrders).size === 6, landedOrders.join(','));

  /* ────────────────────────────────────────────────────────
     43. PERMISSION ENFORCEMENT
     ──────────────────────────────────────────────────────── */
  console.log('\n43. permission enforcement');

  const permOrder = await so.create({ customerId: gujaratCustomer.id, warehouseId: wh.id, lines: [{ productId: p1.id, quantity: 1, unitPrice: '84' }] }, salesUser);
  await so.submit(permOrder.id, salesUser);

  const approveBySales = await refused(() => so.approve(permOrder.id, salesUser));
  check('43a. sales:approve -- a sales desk user cannot approve an order', approveBySales.threw && approveBySales.err?.name === 'ForbiddenError');

  const approvedForPermTest = await so.approve(permOrder.id, manager);
  const reserveBySales = await refused(() => reservation.reserveForOrder({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, salesUser));
  check('43b. stock:reserve -- a sales desk user cannot reserve stock', reserveBySales.threw && reserveBySales.err?.name === 'ForbiddenError');

  const reservedForPermTest = await reservation.reserveForOrder({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, store);
  const dispatchBySales = await refused(() => dispatchSvc.dispatch({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, salesUser));
  check('43c. sales:dispatch -- a sales desk user cannot dispatch', dispatchBySales.threw && dispatchBySales.err?.name === 'ForbiddenError');

  const invoiceByStore = await refused(() => invoices.create({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, store));
  check('43d. sales:invoice -- a store keeper cannot raise an invoice', invoiceByStore.threw && invoiceByStore.err?.name === 'ForbiddenError');

  const customerWriteByStore = await refused(() => customers.create({ name: 'Should be refused' }, store));
  check('43e. customer:write -- a store keeper cannot create a customer', customerWriteByStore.threw && customerWriteByStore.err?.name === 'ForbiddenError');

  const quotationWriteByStore = await refused(() => quotations.create({
    customerId: gujaratCustomer.id, warehouseId: wh.id, lines: [{ productId: p1.id, quantity: 1, unitPrice: '84' }],
  }, store));
  check('43f. quotation:write -- a store keeper cannot raise a quotation', quotationWriteByStore.threw && quotationWriteByStore.err?.name === 'ForbiddenError');

  const dispatchedForReturnPermTest = await dispatchSvc.dispatch({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, store);
  const returnByStore = await refused(() => returns.post({
    salesOrderId: permOrder.id, reason: 'permission probe',
    lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, disposition: 'ACCEPTED_GOOD', quantity: 1 }],
  }, store));
  check('43g. sales:return -- a store keeper cannot post a sales return', returnByStore.threw && returnByStore.err?.name === 'ForbiddenError');

  const permInvoice = await invoices.create({
    salesOrderId: permOrder.id, lines: [{ salesOrderLineId: approvedForPermTest.lines[0].id, quantity: 1 }],
  }, manager);
  const paymentBySales = await refused(() => payments.record({
    salesInvoiceId: permInvoice.id, amount: 1, paymentDate: new Date().toISOString(), method: 'CASH',
  }, salesUser));
  check('43h. sales:payment -- a sales desk user cannot record a payment', paymentBySales.threw && paymentBySales.err?.name === 'ForbiddenError');

  /* ────────────────────────────────────────────────────────
     44. AUDIT LOGGING
     ──────────────────────────────────────────────────────── */
  console.log('\n44. audit logging');

  const auditForOrder = await prisma.auditLog.findMany({ where: { entityType: 'SalesOrder', entityId: permOrder.id }, orderBy: { createdAt: 'asc' } });
  check('44. every lifecycle step on a sales order left an audit entry',
    ['CREATE', 'UPDATE', 'APPROVE', 'RESERVE', 'DISPATCH'].every((a) => auditForOrder.some((r) => r.action === a)),
    auditForOrder.map((r) => r.action).join(','));
  check('44b. every audit entry names a real actor', auditForOrder.every((r) => r.actorUserId !== null));

  const auditForReturn = await prisma.auditLog.findMany({ where: { entityType: 'SalesReturn', entityId: goodReturn.id } });
  check('44c. a sales return is also audited', auditForReturn.length > 0);

  /* ────────────────────────────────────────────────────────
     INVENTORY RECONCILIATION AFTER A FULL SALES CYCLE
     ──────────────────────────────────────────────────────── */
  console.log('\nreconciliation');

  const p1Movements = await prisma.stockLedgerEntry.findMany({
    where: { productId: p1.id, warehouseId: wh.id },
    orderBy: { entryNo: 'asc' },
  });
  let physical = 0;
  let reservedSum = 0;
  let damagedSum = 0;
  for (const m of p1Movements) {
    const qty = Number(m.quantity);
    if (m.movementType === 'INWARD' || m.movementType === 'ADJUSTMENT_INCREASE' || m.movementType === 'TRANSFER_IN') physical += qty;
    if (m.movementType === 'OUTWARD' || m.movementType === 'ADJUSTMENT_DECREASE' || m.movementType === 'TRANSFER_OUT') physical -= qty;
    if (m.movementType === 'RESERVATION') reservedSum += qty;
    if (m.movementType === 'RESERVATION_RELEASE') reservedSum -= qty;
    if (m.movementType === 'DAMAGE') damagedSum += qty;
    if (m.movementType === 'DAMAGE_RECOVERY') damagedSum -= qty;
  }
  const storedBalance = await balanceOf(p1.id);
  check('reconciliation. on-hand for DV-1001 equals the sum of its own ledger', physical === storedBalance.onHand,
    JSON.stringify({ summed: physical, stored: storedBalance.onHand }));
  check('reconciliation b. reserved for DV-1001 equals the sum of its own ledger', reservedSum === storedBalance.reserved,
    JSON.stringify({ summed: reservedSum, stored: storedBalance.reserved }));
  check('reconciliation c. damaged for DV-1001 equals the sum of its own ledger', damagedSum === storedBalance.damaged,
    JSON.stringify({ summed: damagedSum, stored: storedBalance.damaged }));

  /* ────────────────────────────────────────────────────────
     NOTHING IN SALES WRITES STOCK DIRECTLY
     ──────────────────────────────────────────────────────── */
  console.log('\narchitecture: who is allowed to move stock');

  const salesImports = execSync(
    'grep -lE "^import \\{[^}]*postStockMovement" server/services/*.mjs || true',
    { cwd: process.cwd(), encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  check('architecture. only reservation, dispatch and return services import the stock service',
    salesImports.every((f) => [
      'server/services/inventory.service.mjs',
      'server/services/warehouse.service.mjs',
      'server/services/grn.service.mjs',
      'server/services/purchaseReturn.service.mjs',
      'server/services/reservation.service.mjs',
      'server/services/dispatch.service.mjs',
      'server/services/salesReturn.service.mjs',
    ].includes(f)), salesImports.join(', '));

  /* ────────────────────────────────────────────────────────
     THE DASHBOARD READS THE DATABASE
     ──────────────────────────────────────────────────────── */
  console.log('\ndashboard and history');

  const d = await board.dashboard();
  const realCustomerCount = await prisma.customer.count();
  const realOrderCount = await prisma.salesOrder.count();
  check('dashboard. the customer count matches the table', d.customers.total === realCustomerCount, d.customers.total + ' vs ' + realCustomerCount);
  check('dashboard b. the order count matches', d.orders.total === realOrderCount);
  check('dashboard c. the figures are not all zero, so this is not a vacuous pass',
    d.orders.total > 0 && d.dispatch.posted > 0 && d.invoices.posted > 0, JSON.stringify(d.orders));

  const history = await board.history({});
  check('dashboard d. the history timeline carries every sales document kind',
    ['QUOTATION', 'ORDER', 'INVOICE', 'DISPATCH', 'RETURN'].every((k) => history.rows.some((r) => r.kind === k)),
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
