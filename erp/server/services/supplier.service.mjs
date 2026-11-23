import { prisma } from '../../db/client.mjs';
import { record } from './audit.mjs';
import { normaliseCode } from './normalise.mjs';
import { stateCodeOf, stateCodeDisagreesWithGstin } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   SUPPLIERS
   ============================================================

   REUSED, NOT REBUILT. The Supplier model has existed since step
   2 and already held a code, name, GSTIN, contact and payment
   terms. Step 6 added state codes, a shipping address, a credit
   period and notes to it, and this service is the first code to
   read or write any of it.

   Supplier and Customer are SEPARATE MODELS and stay that way.
   They were separate before step 6 and nothing here merges them:
   a party that is both is two rows, which is the right answer
   when the two relationships carry different terms, different
   registrations and different histories. A single Party model
   with a role flag would be the other defensible design, and
   switching to it now would be a rewrite of step 2 rather than
   the reuse the brief asks for.

   A SUPPLIER IS NEVER DELETED. One with any purchase history
   cannot be removed without orphaning the orders, receipts and
   invoices that explain where stock and money went; the database
   restricts it and there is no delete endpoint. Deactivating is
   the supported answer.
   ============================================================ */

const SELECT = {
  id: true, code: true, name: true, gstin: true,
  contactName: true, contactEmail: true, contactPhone: true,
  addressLine: true, city: true, state: true, stateCode: true, postalCode: true,
  shippingAddressLine: true, shippingCity: true, shippingState: true,
  shippingStateCode: true, shippingPostalCode: true,
  paymentTerms: true, creditPeriodDays: true, notes: true, isActive: true,
  createdAt: true, updatedAt: true,
};

export async function list({ search, isActive, stateCode, page = 1, pageSize = 50 } = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(isActive === undefined ? {} : { isActive }),
    ...(stateCode ? { stateCode } : {}),
    ...(search
      ? {
        OR: [
          { name: { contains: search, mode: 'insensitive' } },
          { code: { contains: search, mode: 'insensitive' } },
          { gstin: { contains: search, mode: 'insensitive' } },
          { city: { contains: search, mode: 'insensitive' } },
          { contactName: { contains: search, mode: 'insensitive' } },
          { contactPhone: { contains: search, mode: 'insensitive' } },
        ],
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.supplier.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take,
      select: { ...SELECT, _count: { select: { purchaseOrders: true, goodsReceipts: true, invoices: true } } },
    }),
    prisma.supplier.count({ where }),
  ]);

  return {
    rows: rows.map(shape),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function get(id) {
  const supplier = await prisma.supplier.findUnique({
    where: { id },
    select: { ...SELECT, _count: { select: { purchaseOrders: true, goodsReceipts: true, invoices: true, purchaseReturns: true } } },
  });
  if (!supplier) throw new NotFoundError('Supplier');
  return shape(supplier);
}

/**
 * What this supplier has actually traded.
 *
 * Orders, receipts and invoices side by side, because the useful
 * question about a supplier is rarely "what did we order" alone --
 * it is whether what was ordered arrived and whether what arrived
 * matches what we were billed for.
 */
export async function history(id, { page = 1, pageSize = 25 } = {}) {
  const supplier = await get(id);
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [orders, total, receipts, invoices, returns, ordered] = await Promise.all([
    prisma.purchaseOrder.findMany({
      where: { supplierId: id },
      orderBy: { orderDate: 'desc' },
      skip,
      take,
      select: {
        id: true, orderNo: true, status: true, orderDate: true, expectedDate: true,
        grandTotal: true, currency: true, gstTreatment: true,
        warehouse: { select: { id: true, name: true } },
        _count: { select: { lines: true, receipts: true } },
      },
    }),
    prisma.purchaseOrder.count({ where: { supplierId: id } }),
    prisma.goodsReceiptNote.findMany({
      where: { supplierId: id, status: 'POSTED' },
      orderBy: { receiptDate: 'desc' },
      take: 10,
      select: {
        id: true, grnNo: true, receiptDate: true,
        purchaseOrder: { select: { orderNo: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.supplierInvoice.findMany({
      where: { supplierId: id },
      orderBy: { invoiceDate: 'desc' },
      take: 10,
      select: { id: true, invoiceNo: true, invoiceDate: true, invoiceAmount: true, status: true },
    }),
    prisma.purchaseReturn.count({ where: { supplierId: id, status: 'POSTED' } }),
    /* Value traded, excluding orders that were called off. A
       cancelled order is not business the studio did, and counting
       it would flatter the figure. */
    prisma.purchaseOrder.aggregate({
      where: { supplierId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    }),
  ]);

  return {
    supplier,
    summary: {
      ordersPlaced: ordered._count._all,
      valueOrdered: Number(ordered._sum.grandTotal ?? 0),
      receiptsPosted: receipts.length,
      returnsPosted: returns,
    },
    orders: orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      status: o.status,
      orderDate: o.orderDate,
      expectedDate: o.expectedDate,
      warehouse: o.warehouse,
      lineCount: o._count.lines,
      receiptCount: o._count.receipts,
      gstTreatment: o.gstTreatment,
      grandTotal: Number(o.grandTotal),
      currency: o.currency,
    })),
    recentReceipts: receipts.map((r) => ({
      id: r.id,
      grnNo: r.grnNo,
      receiptDate: r.receiptDate,
      orderNo: r.purchaseOrder?.orderNo ?? null,
      lineCount: r._count.lines,
    })),
    recentInvoices: invoices.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      invoiceDate: i.invoiceDate,
      amount: Number(i.invoiceAmount),
      status: i.status,
    })),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function create(input, actor) {
  const data = await validated(input, null);

  const clash = await prisma.supplier.findFirst({
    where: { name: { equals: data.name, mode: 'insensitive' } },
    select: { id: true, name: true, code: true },
  });
  if (clash) {
    throw new ConflictError(
      'A supplier called "' + clash.name + '" already exists (' + clash.code + '). '
      + 'Two rows for one supplier split its history in half.',
      { existingId: clash.id, code: clash.code },
    );
  }

  const wanted = normaliseCode(input.code)
    || normaliseCode('SUP-' + data.name).slice(0, 10)
    || 'SUP';

  return prisma.$transaction(async (tx) => {
    const supplier = await tx.supplier.create({
      data: { ...data, code: await freeCode(tx, wanted) },
      select: SELECT,
    });

    await record(tx, {
      entityType: 'Supplier',
      entityId: supplier.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: supplier.name, code: supplier.code, gstin: supplier.gstin },
      summary: 'Created supplier ' + supplier.name + ' (' + supplier.code + ')',
    });

    return shape(supplier);
  });
}

export async function update(id, input, actor) {
  const before = await prisma.supplier.findUnique({ where: { id }, select: SELECT });
  if (!before) throw new NotFoundError('Supplier');

  const data = await validated(input, before);

  if (data.name && data.name.toLowerCase() !== before.name.toLowerCase()) {
    const clash = await prisma.supplier.findFirst({
      where: { name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
      select: { name: true, code: true },
    });
    if (clash) {
      throw new ConflictError('Another supplier is already called "' + clash.name + '" (' + clash.code + ').');
    }
  }

  /* THE CODE IS QUOTED ON PAPERWORK AND GROUPED ON IN REPORTS.
     Changing it after the supplier has traded renames history, so
     it is refused once anything references them. */
  if (input.code !== undefined && normaliseCode(input.code) !== before.code) {
    const traded = await prisma.purchaseOrder.count({ where: { supplierId: id } });
    if (traded > 0) {
      throw new ConflictError(
        'This supplier code cannot be changed: ' + traded + ' purchase order(s) already quote it.',
        { currentCode: before.code, orders: traded },
      );
    }
    data.code = normaliseCode(input.code);
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.supplier.update({ where: { id }, data, select: SELECT });
    await record(tx, {
      entityType: 'Supplier',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated supplier ' + after.name,
    });
    return shape(after);
  });
}

/**
 * Activate or deactivate. NEVER DELETE.
 *
 * A deactivated supplier keeps every order, receipt and invoice it
 * ever had; it simply cannot be chosen for a new one. Deleting it
 * would orphan that history, and the database refuses it anyway.
 */
export async function setActive(id, isActive, actor, reason) {
  const supplier = await prisma.supplier.findUnique({ where: { id }, select: SELECT });
  if (!supplier) throw new NotFoundError('Supplier');

  if (!isActive) {
    /* An order still in flight is the thing worth stopping. Once
       the supplier is inactive nobody can raise a receipt against
       them, and goods already on the way would have nowhere to be
       booked in. */
    const open = await prisma.purchaseOrder.count({
      where: { supplierId: id, status: { in: ['PENDING_APPROVAL', 'APPROVED', 'PARTIALLY_RECEIVED'] } },
    });
    if (open > 0) {
      throw new ConflictError(
        supplier.name + ' has ' + open + ' purchase order(s) still open. '
        + 'Receive or close them first — goods already on their way could not be '
        + 'booked in against a deactivated supplier.',
        { openOrders: open },
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.supplier.update({ where: { id }, data: { isActive }, select: SELECT });
    await record(tx, {
      entityType: 'Supplier',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before: { isActive: supplier.isActive },
      after: { isActive },
      summary: (isActive ? 'Activated ' : 'Deactivated ') + supplier.name
        + (reason ? ': ' + reason : ''),
    });
    return shape(after);
  });
}

/* ── validation ──────────────────────────────────────────── */

async function validated(input, existing) {
  const fields = [];
  const data = {};

  if (input.name !== undefined || !existing) {
    const name = String(input.name ?? '').replace(/\s+/g, ' ').trim();
    if (!name) fields.push({ field: 'name', message: 'A supplier needs a name.' });
    else data.name = name;
  }

  const gstin = input.gstin === undefined ? existing?.gstin : (String(input.gstin ?? '').trim().toUpperCase() || null);
  if (input.gstin !== undefined) data.gstin = gstin;

  /* A GSTIN is fifteen characters in a fixed shape: two state
     digits, a ten-character PAN, an entity digit, a Z, and a
     checksum character. Checked because a malformed one silently
     breaks the state-code derivation that decides the tax. */
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]{3}$/.test(gstin)) {
    fields.push({
      field: 'gstin',
      message: 'That is not a valid GSTIN. It is fifteen characters: two state digits, '
        + 'a PAN, and three more.',
    });
  }

  for (const key of [
    'contactName', 'contactEmail', 'contactPhone', 'addressLine', 'city', 'state',
    'postalCode', 'shippingAddressLine', 'shippingCity', 'shippingState',
    'shippingPostalCode', 'paymentTerms', 'notes',
  ]) {
    if (input[key] !== undefined) data[key] = String(input[key] ?? '').trim() || null;
  }

  if (input.contactEmail !== undefined && data.contactEmail
      && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.contactEmail)) {
    fields.push({ field: 'contactEmail', message: 'That does not look like an email address.' });
  }

  for (const key of ['stateCode', 'shippingStateCode']) {
    if (input[key] === undefined) continue;
    const code = String(input[key] ?? '').trim();
    if (!code) { data[key] = null; continue; }
    if (!/^[0-9]{2}$/.test(code)) {
      fields.push({ field: key, message: 'A GST state code is exactly two digits, such as 24 for Gujarat.' });
    } else {
      data[key] = code;
    }
  }

  if (input.creditPeriodDays !== undefined) {
    if (input.creditPeriodDays === null || input.creditPeriodDays === '') {
      data.creditPeriodDays = null;
    } else {
      const days = Number(input.creditPeriodDays);
      if (!Number.isInteger(days) || days < 0 || days > 365) {
        fields.push({ field: 'creditPeriodDays', message: 'A credit period is a whole number of days, 0 to 365.' });
      } else {
        data.creditPeriodDays = days;
      }
    }
  }

  if (input.isActive !== undefined) data.isActive = Boolean(input.isActive);

  /* THE STATE CODE IS DERIVED FROM THE GSTIN when there is one,
     because the first two characters of a GSTIN ARE the state
     code. Deriving it rather than asking twice removes the whole
     class of bug where the two disagree. */
  const merged = { gstin, stateCode: data.stateCode ?? existing?.stateCode ?? null };
  if (gstin && stateCodeDisagreesWithGstin(merged)) {
    fields.push({
      field: 'stateCode',
      message: 'This state code (' + merged.stateCode + ') contradicts the GSTIN, which begins '
        + String(gstin).slice(0, 2) + '. One of the two is a typing error, and the tax on every '
        + 'order from this supplier depends on which.',
    });
  }
  if (gstin && !merged.stateCode) data.stateCode = stateCodeOf({ gstin });

  if (fields.length) throw new ValidationError(fields);
  return data;
}

function shape(s) {
  return {
    id: s.id,
    code: s.code,
    name: s.name,
    gstin: s.gstin,
    contact: {
      name: s.contactName,
      email: s.contactEmail,
      phone: s.contactPhone,
    },
    billing: {
      addressLine: s.addressLine,
      city: s.city,
      state: s.state,
      stateCode: s.stateCode,
      postalCode: s.postalCode,
    },
    shipping: {
      addressLine: s.shippingAddressLine,
      city: s.shippingCity,
      state: s.shippingState,
      stateCode: s.shippingStateCode,
      postalCode: s.shippingPostalCode,
    },
    paymentTerms: s.paymentTerms,
    creditPeriodDays: s.creditPeriodDays,
    notes: s.notes,
    isActive: s.isActive,
    orderCount: s._count?.purchaseOrders ?? null,
    receiptCount: s._count?.goodsReceipts ?? null,
    invoiceCount: s._count?.invoices ?? null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function freeCode(tx, wanted) {
  let code = wanted;
  for (let n = 2; n < 100; n += 1) {
    const taken = await tx.supplier.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
    code = wanted.slice(0, 8) + n;
  }
  throw new ConflictError('Could not allocate a supplier code.');
}

/** One line per supplier, for a dropdown. */
export async function options() {
  const rows = await prisma.supplier.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: { id: true, code: true, name: true, gstin: true, stateCode: true,
      state: true, paymentTerms: true, creditPeriodDays: true,
      addressLine: true, city: true, postalCode: true },
  });
  return { rows };
}
