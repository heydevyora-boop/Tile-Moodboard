import { prisma } from '../../db/client.mjs';
import { nextDocumentNumber } from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { assertCan } from './permission.mjs';
import { computeLine, computeTotals, salesGstTreatmentFor, gstRateForHsn } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   QUOTATIONS
   ============================================================

   A QUOTATION NEVER TOUCHES STOCK. Nothing here imports
   postStockMovement, or reserve(), or anything else that could
   move a balance. Raising, sending, revising or even accepting a
   quotation changes no inventory figure, because a quotation is a
   proposal and a proposal is not a commitment the warehouse has
   to honour.

   CONVERSION IS NEVER AUTOMATIC. Creating a quotation never
   creates a sales order on its own -- convert() is the one path
   from a quotation to an order, it requires sales:write the same
   as raising an order from scratch, and it is a deliberate act a
   person takes, not a side effect of something else.

   REVISIONS form a chain through revisionOf: the first quotation
   in a chain is its own root (revisionOf is null, revisionNo 1),
   and each later revision points back to the one it supersedes.
   A superseded quotation is not deleted -- nothing here deletes a
   quotation -- it is left in whatever status it was in, usually
   CANCELLED by the revise() call, so the chain is the whole
   history of what was offered and when it changed.
   ============================================================ */

const TRANSITIONS = {
  DRAFT: ['SENT', 'CANCELLED'],
  SENT: ['ACCEPTED', 'REJECTED', 'EXPIRED', 'CANCELLED'],
  ACCEPTED: ['CONVERTED', 'CANCELLED'],
  REJECTED: [],
  EXPIRED: [],
  CONVERTED: [],
  CANCELLED: [],
};

function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

const WORDS = {
  DRAFT: 'a draft', SENT: 'sent', ACCEPTED: 'accepted', REJECTED: 'rejected',
  EXPIRED: 'expired', CONVERTED: 'converted', CANCELLED: 'cancelled',
};
const readable = (s) => WORDS[s] ?? s;

function assertTransition(q, to) {
  if (canTransition(q.status, to)) return;
  throw new ConflictError(
    'Quotation ' + q.quotationNo + ' is ' + readable(q.status) + ' and cannot become ' + readable(to) + '.',
    { from: q.status, to, allowedFromHere: TRANSITIONS[q.status] ?? [] },
  );
}

const LINE_SELECT = {
  id: true, lineNo: true, productId: true, skuAtQuote: true, nameAtQuote: true,
  hsnAtQuote: true, description: true, quantity: true, uom: true, unitPrice: true,
  discountPercent: true, discountAmount: true, grossAmount: true, taxableValue: true,
  taxRate: true, cgstAmount: true, sgstAmount: true, igstAmount: true, taxAmount: true,
  lineTotal: true,
};

const HEAD_SELECT = {
  id: true, quotationNo: true, status: true, revisionOf: true, revisionNo: true,
  quotationDate: true, expiryDate: true, billingAddress: true, shippingAddress: true,
  paymentTerms: true, deliveryTerms: true, notes: true,
  subTotal: true, discountTotal: true, taxableTotal: true,
  cgstTotal: true, sgstTotal: true, igstTotal: true, taxTotal: true, grandTotal: true, currency: true,
  sentAt: true, respondedAt: true, convertedAt: true, cancelledAt: true,
  createdAt: true, updatedAt: true,
  customer: { select: { id: true, code: true, name: true, gstin: true, stateCode: true, shippingStateCode: true } },
  warehouse: { select: { id: true, code: true, name: true, stateCode: true } },
  createdBy: { select: { id: true, name: true } },
  convertedBy: { select: { id: true, name: true } },
};

/* ============================================================
   READING
   ============================================================ */

export async function list(query = {}) {
  const { search, status, customerId, from, to, page = 1, pageSize = 25 } = query;
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const statuses = status && status !== 'all'
    ? String(status).split(',').filter((s) => s in TRANSITIONS)
    : null;

  const where = {
    ...(statuses?.length ? { status: { in: statuses } } : {}),
    ...(customerId && customerId !== 'all' ? { customerId } : {}),
    ...(from || to
      ? { quotationDate: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: endOfDay(to) } : {}) } }
      : {}),
    ...(search
      ? {
        OR: [
          { quotationNo: { contains: search, mode: 'insensitive' } },
          { customer: { name: { contains: search, mode: 'insensitive' } } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      orderBy: [{ quotationDate: 'desc' }, { quotationNo: 'desc' }],
      skip,
      take,
      select: { ...HEAD_SELECT, _count: { select: { lines: true } } },
    }),
    prisma.quotation.count({ where }),
  ]);

  return {
    rows: rows.map(shapeHead),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const q = await prisma.quotation.findUnique({
    where: { id },
    select: {
      ...HEAD_SELECT,
      lines: { orderBy: { lineNo: 'asc' }, select: LINE_SELECT },
      salesOrders: { select: { id: true, orderNo: true, status: true } },
      laterRevisions: { select: { id: true, quotationNo: true, revisionNo: true, status: true } },
      previousRevision: { select: { id: true, quotationNo: true, revisionNo: true } },
    },
  });
  if (!q) throw new NotFoundError('Quotation');

  return {
    ...shapeHead(q),
    lines: q.lines.map(shapeLine),
    convertedToOrders: q.salesOrders,
    laterRevisions: q.laterRevisions,
    previousRevision: q.previousRevision,
    allowed: {
      edit: q.status === 'DRAFT',
      send: canTransition(q.status, 'SENT'),
      respond: q.status === 'SENT',
      convert: canTransition(q.status, 'CONVERTED'),
      revise: ['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].includes(q.status),
      cancel: canTransition(q.status, 'CANCELLED'),
    },
  };
}

/* ============================================================
   CREATE AND EDIT
   ============================================================ */

export async function create(input, actor) {
  await assertCan(actor, 'quotation:write');
  const { customer, warehouse, lines, head } = await validateDraft(input);

  const quotationNo = await nextDocumentNumber('QUOTATION');

  const id = await prisma.$transaction(async (tx) => {
    const q = await tx.quotation.create({
      data: {
        quotationNo,
        customerId: customer.id,
        warehouseId: warehouse?.id ?? null,
        status: 'DRAFT',
        quotationDate: head.quotationDate,
        expiryDate: head.expiryDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        deliveryTerms: head.deliveryTerms,
        notes: head.notes,
        currency: head.currency,
        ...head.totals,
        createdById: actor.id,
        lines: { create: lines },
      },
      select: { id: true },
    });

    await record(tx, {
      entityType: 'Quotation',
      entityId: q.id,
      action: 'CREATE',
      actorUserId: actor.id,
      summary: 'Raised ' + quotationNo + ' for ' + customer.name + ', ' + lines.length
        + ' line(s), ' + head.totals.grandTotal + ' ' + head.currency + '. No stock is affected.',
    });

    return q.id;
  });

  return get(id);
}

/** Draft only, same rule as a purchase order. */
export async function update(id, input, actor) {
  await assertCan(actor, 'quotation:write');

  const existing = await prisma.quotation.findUnique({
    where: { id }, select: { id: true, quotationNo: true, status: true },
  });
  if (!existing) throw new NotFoundError('Quotation');
  if (existing.status !== 'DRAFT') {
    throw new ConflictError(
      'Quotation ' + existing.quotationNo + ' is ' + readable(existing.status)
      + ' and cannot be edited. Once it has been sent, revise it instead so the customer '
      + 'sees what changed.',
      { status: existing.status },
    );
  }

  const { customer, warehouse, lines, head } = await validateDraft(input);

  await prisma.$transaction(async (tx) => {
    await tx.quotationLine.deleteMany({ where: { quotationId: id } });
    await tx.quotation.update({
      where: { id },
      data: {
        customerId: customer.id,
        warehouseId: warehouse?.id ?? null,
        quotationDate: head.quotationDate,
        expiryDate: head.expiryDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        deliveryTerms: head.deliveryTerms,
        notes: head.notes,
        currency: head.currency,
        ...head.totals,
        lines: { create: lines },
      },
    });
    await record(tx, {
      entityType: 'Quotation',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor.id,
      summary: 'Edited draft ' + existing.quotationNo + ': ' + lines.length + ' line(s), '
        + head.totals.grandTotal + ' ' + head.currency + '.',
    });
  });

  return get(id);
}

/* ============================================================
   THE LIFECYCLE
   ============================================================ */

export async function send(id, actor) {
  await assertCan(actor, 'quotation:write');
  const q = await load(id);
  assertTransition(q, 'SENT');

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
    await record(tx, {
      entityType: 'Quotation', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: 'Sent ' + q.quotationNo + ' to ' + q.customer.name + '.',
    });
  });
  return get(id);
}

/** The customer's response: ACCEPTED, REJECTED or EXPIRED. */
export async function respond(id, status, actor) {
  await assertCan(actor, 'quotation:write');
  if (!['ACCEPTED', 'REJECTED', 'EXPIRED'].includes(status)) {
    throw new ValidationError([{ field: 'status', message: 'Not a valid response.' }]);
  }
  const q = await load(id);
  assertTransition(q, status);

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({ where: { id }, data: { status, respondedAt: new Date() } });
    await record(tx, {
      entityType: 'Quotation', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: q.quotationNo + ' marked ' + readable(status) + '.',
    });
  });
  return get(id);
}

export async function cancel(id, actor, reason) {
  await assertCan(actor, 'quotation:write');
  const q = await load(id);
  assertTransition(q, 'CANCELLED');

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
    await record(tx, {
      entityType: 'Quotation', entityId: id, action: 'CANCEL', actorUserId: actor.id,
      summary: 'Cancelled ' + q.quotationNo + (reason ? ': ' + reason : '') + '.',
    });
  });
  return get(id);
}

/**
 * REVISE — a new quotation, carrying the chain forward.
 *
 * The old one is superseded (CANCELLED, with a note) rather than
 * edited: a customer who already saw version 1 must be able to
 * compare it against version 2, not discover it was rewritten
 * underneath them.
 */
export async function revise(id, input, actor) {
  await assertCan(actor, 'quotation:write');

  const existing = await prisma.quotation.findUnique({
    where: { id },
    select: { id: true, quotationNo: true, status: true, revisionNo: true, customerId: true },
  });
  if (!existing) throw new NotFoundError('Quotation');
  if (!['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].includes(existing.status)) {
    throw new ConflictError(
      'Quotation ' + existing.quotationNo + ' is ' + readable(existing.status)
      + ' and cannot be revised. A draft is simply edited; a converted or cancelled '
      + 'quotation is finished with.',
      { status: existing.status },
    );
  }

  const { customer, warehouse, lines, head } = await validateDraft({
    ...input, customerId: input.customerId ?? existing.customerId,
  });
  const quotationNo = await nextDocumentNumber('QUOTATION');

  const id2 = await prisma.$transaction(async (tx) => {
    const revised = await tx.quotation.create({
      data: {
        quotationNo,
        customerId: customer.id,
        warehouseId: warehouse?.id ?? null,
        status: 'DRAFT',
        revisionOf: existing.id,
        revisionNo: existing.revisionNo + 1,
        quotationDate: head.quotationDate,
        expiryDate: head.expiryDate,
        billingAddress: head.billingAddress,
        shippingAddress: head.shippingAddress,
        paymentTerms: head.paymentTerms,
        deliveryTerms: head.deliveryTerms,
        notes: head.notes,
        currency: head.currency,
        ...head.totals,
        createdById: actor.id,
        lines: { create: lines },
      },
      select: { id: true },
    });

    await tx.quotation.update({ where: { id: existing.id }, data: { status: 'CANCELLED', cancelledAt: new Date() } });

    await record(tx, {
      entityType: 'Quotation', entityId: revised.id, action: 'CREATE', actorUserId: actor.id,
      summary: quotationNo + ' supersedes ' + existing.quotationNo + ' (revision ' + (existing.revisionNo + 1) + ').',
    });
    await record(tx, {
      entityType: 'Quotation', entityId: existing.id, action: 'CANCEL', actorUserId: actor.id,
      summary: existing.quotationNo + ' superseded by ' + quotationNo + '.',
    });

    return revised.id;
  });

  return get(id2);
}

/**
 * CONVERT — the one path from a quotation to a sales order.
 *
 * Never automatic. Requires sales:write, same as raising an order
 * from nothing, because that is exactly what this does: it reads
 * the quotation's own lines and prices (not today's Product
 * Master prices) and hands them to salesOrder.service.mjs to
 * build a fresh DRAFT order from. No stock moves here either --
 * the new order is a draft, and has to go through the same
 * approval and reservation steps as any other.
 */
export async function convert(id, actor, overrides = {}) {
  await assertCan(actor, 'sales:write');

  const q = await prisma.quotation.findUnique({
    where: { id },
    select: {
      id: true, quotationNo: true, status: true, customerId: true, warehouseId: true,
      billingAddress: true, shippingAddress: true, paymentTerms: true,
      lines: { orderBy: { lineNo: 'asc' } },
    },
  });
  if (!q) throw new NotFoundError('Quotation');
  assertTransition(q, 'CONVERTED');

  if (!q.warehouseId && !overrides.warehouseId) {
    throw new ValidationError([{
      field: 'warehouseId',
      message: 'This quotation named no warehouse preference. Choose one to fulfil the order from.',
    }]);
  }

  // Deliberately lazy-imported: salesOrder.service.mjs imports
  // quotation data shapes from nowhere, but importing it at the
  // top of this file would be a cycle (salesOrder needs nothing
  // from here, but keeping the dependency one-directional --
  // quotation knows about sales orders, not the reverse --
  // is what makes "a quotation never creates an order on its
  // own" easy to verify by reading one file).
  const salesOrder = await import('./salesOrder.service.mjs');

  const draft = await salesOrder.createFromQuotation({
    quotation: q,
    warehouseId: overrides.warehouseId ?? q.warehouseId,
  }, actor);

  await prisma.$transaction(async (tx) => {
    await tx.quotation.update({
      where: { id },
      data: { status: 'CONVERTED', convertedAt: new Date(), convertedById: actor.id },
    });
    await record(tx, {
      entityType: 'Quotation', entityId: id, action: 'UPDATE', actorUserId: actor.id,
      summary: q.quotationNo + ' converted to ' + draft.orderNo + '. The order is a draft '
        + 'and still has to be approved and reserved; nothing has shipped.',
    });
  });

  return get(id).then((full) => ({ ...full, newOrder: draft }));
}

/* ============================================================
   VALIDATION AND PRICING
   ============================================================ */

async function load(id) {
  const q = await prisma.quotation.findUnique({
    where: { id },
    select: { id: true, quotationNo: true, status: true, customer: { select: { name: true } } },
  });
  if (!q) throw new NotFoundError('Quotation');
  return q;
}

async function validateDraft(input) {
  const fields = [];
  if (!input.customerId) fields.push({ field: 'customerId', message: 'Choose a customer.' });
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    fields.push({ field: 'lines', message: 'A quotation needs at least one line.' });
  }
  if (fields.length) throw new ValidationError(fields);

  const [customer, warehouse] = await Promise.all([
    prisma.customer.findUnique({ where: { id: input.customerId } }),
    input.warehouseId ? prisma.warehouse.findUnique({ where: { id: input.warehouseId } }) : null,
  ]);
  if (!customer) fields.push({ field: 'customerId', message: 'No such customer.' });
  else if (!customer.isActive) fields.push({ field: 'customerId', message: customer.name + ' is deactivated.' });
  if (input.warehouseId && !warehouse) fields.push({ field: 'warehouseId', message: 'No such warehouse.' });
  if (fields.length) throw new ValidationError(fields);

  // A quotation's GST is a PREVIEW, not a commitment -- there is
  // no inventory movement to protect, so a quotation with no
  // warehouse preference yet is allowed, and its tax is computed
  // against the studio's default (first active) warehouse purely
  // to show a realistic figure. The sales order built from it, at
  // conversion, computes its own treatment for real.
  const gstWarehouse = warehouse ?? await prisma.warehouse.findFirst({ where: { isActive: true } });
  let gst = { treatment: 'INTRA_STATE' };
  if (gstWarehouse) {
    const decided = salesGstTreatmentFor({ warehouse: gstWarehouse, customer });
    if (!decided.error) gst = decided;
  }

  const productIds = [...new Set(input.lines.map((l) => l?.productId).filter(Boolean))];
  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true, sku: true, name: true, uom: true, status: true, archivedAt: true,
      sellingPrice: true, hsnCode: true, category: { select: { hsnCode: true } },
    },
  });
  const byId = new Map(products.map((p) => [p.id, p]));

  const lines = [];
  const computed = [];

  input.lines.forEach((raw, i) => {
    const at = (f) => 'lines[' + i + '].' + f;
    if (!raw?.productId) {
      fields.push({ field: at('productId'), message: 'Line ' + (i + 1) + ' has no product.' });
      return;
    }
    const product = byId.get(raw.productId);
    if (!product) { fields.push({ field: at('productId'), message: 'No such product.' }); return; }
    if (product.archivedAt) {
      fields.push({ field: at('productId'), message: product.sku + ' is archived.' });
      return;
    }

    const quantity = Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      fields.push({ field: at('quantity'), message: 'A quantity above zero is required.' });
      return;
    }

    const unitPrice = raw.unitPrice === undefined || raw.unitPrice === null || raw.unitPrice === ''
      ? product.sellingPrice : raw.unitPrice;
    if (unitPrice === null || unitPrice === undefined) {
      fields.push({ field: at('unitPrice'), message: product.sku + ' has no selling price on record; give a rate.' });
      return;
    }

    const hsn = product.hsnCode ?? product.category?.hsnCode ?? null;
    const taxRate = raw.taxRate === undefined || raw.taxRate === null || raw.taxRate === ''
      ? gstRateForHsn(hsn) : Number(raw.taxRate);
    if (taxRate === null) {
      fields.push({ field: at('taxRate'), message: product.sku + ' has no recognised HSN code; give the GST rate.' });
      return;
    }

    let math;
    try {
      math = computeLine({
        quantity, unitPrice,
        discountPercent: raw.discountPercent ?? 0,
        discountAmount: raw.discountAmount,
        taxRate, treatment: gst.treatment,
      });
    } catch (err) {
      fields.push({ field: at('quantity'), message: err.message });
      return;
    }

    computed.push(math);
    lines.push({
      lineNo: lines.length + 1,
      productId: product.id,
      skuAtQuote: product.sku,
      nameAtQuote: product.name,
      hsnAtQuote: hsn,
      description: raw.description ? String(raw.description).trim() : null,
      quantity: math.quantity,
      uom: raw.uom ?? product.uom,
      unitPrice: math.unitPrice,
      discountPercent: math.discountPercent,
      discountAmount: math.discountAmount,
      grossAmount: math.grossAmount,
      taxableValue: math.taxableValue,
      taxRate: math.taxRate,
      cgstAmount: math.cgstAmount,
      sgstAmount: math.sgstAmount,
      igstAmount: math.igstAmount,
      taxAmount: math.taxAmount,
      lineTotal: math.lineTotal,
    });
  });

  if (fields.length) throw new ValidationError(fields);

  const quotationDate = input.quotationDate ? new Date(input.quotationDate) : new Date();
  const expiryDate = input.expiryDate ? new Date(input.expiryDate) : null;

  return {
    customer, warehouse, lines,
    head: {
      quotationDate,
      expiryDate,
      billingAddress: text(input.billingAddress),
      shippingAddress: text(input.shippingAddress),
      paymentTerms: text(input.paymentTerms) ?? customer.paymentTerms ?? null,
      deliveryTerms: text(input.deliveryTerms),
      notes: text(input.notes),
      currency: text(input.currency) ?? 'INR',
      // A quotation has no otherCharges column -- unlike an order
      // or an invoice, it carries no shipping/handling charge of
      // its own -- so that field of computeTotals() is dropped
      // here rather than at every call site that spreads `totals`.
      totals: (({ otherCharges, ...rest }) => rest)(computeTotals(computed, {})),
    },
  };
}

const text = (v) => { const s = String(v ?? '').trim(); return s === '' ? null : s; };
function endOfDay(value) { const d = new Date(value); d.setHours(23, 59, 59, 999); return d; }

function shapeHead(q) {
  return {
    id: q.id,
    quotationNo: q.quotationNo,
    status: q.status,
    statusLabel: readable(q.status),
    revisionOf: q.revisionOf,
    revisionNo: q.revisionNo,
    quotationDate: q.quotationDate,
    expiryDate: q.expiryDate,
    customer: q.customer,
    warehouse: q.warehouse,
    billingAddress: q.billingAddress,
    shippingAddress: q.shippingAddress,
    paymentTerms: q.paymentTerms,
    deliveryTerms: q.deliveryTerms,
    notes: q.notes,
    totals: {
      subTotal: Number(q.subTotal),
      discountTotal: Number(q.discountTotal),
      taxableTotal: Number(q.taxableTotal),
      cgstTotal: Number(q.cgstTotal),
      sgstTotal: Number(q.sgstTotal),
      igstTotal: Number(q.igstTotal),
      taxTotal: Number(q.taxTotal),
      grandTotal: Number(q.grandTotal),
    },
    currency: q.currency,
    lineCount: q._count?.lines ?? null,
    createdBy: q.createdBy?.name ?? null,
    convertedBy: q.convertedBy?.name ?? null,
    sentAt: q.sentAt,
    respondedAt: q.respondedAt,
    convertedAt: q.convertedAt,
    cancelledAt: q.cancelledAt,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
  };
}

function shapeLine(l) {
  return {
    id: l.id, lineNo: l.lineNo, productId: l.productId,
    sku: l.skuAtQuote, name: l.nameAtQuote, hsnCode: l.hsnAtQuote, description: l.description,
    quantity: Number(l.quantity), uom: l.uom, unitPrice: Number(l.unitPrice),
    discountPercent: Number(l.discountPercent), discountAmount: Number(l.discountAmount),
    grossAmount: Number(l.grossAmount), taxableValue: Number(l.taxableValue),
    taxRate: Number(l.taxRate), cgstAmount: Number(l.cgstAmount), sgstAmount: Number(l.sgstAmount),
    igstAmount: Number(l.igstAmount), taxAmount: Number(l.taxAmount), lineTotal: Number(l.lineTotal),
  };
}
