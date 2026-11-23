import { prisma } from '../../db/client.mjs';
import { record } from './audit.mjs';
import { normaliseCode } from './normalise.mjs';
import { stateCodeDisagreesWithGstin } from './money.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';
import { assertCan } from './permission.mjs';

/* ============================================================
   CUSTOMERS
   ============================================================

   REUSED, NOT REBUILT. The Customer model has existed since step
   2 and already held a code, name, type, GSTIN and contact. Step
   7 added state codes, a shipping address, a credit period and
   notes to it -- the same shape step 6 added to Supplier -- and
   this service is the first code to read or write any of it.

   Customer and Supplier are SEPARATE MODELS and stay that way,
   for the same reason stated in supplier.service.mjs: they carry
   different registrations, terms and histories, and a single
   Party model with a role flag would be a rewrite of step 2
   rather than the reuse the brief asks for. Where the business
   genuinely has one counterparty in both roles today, that is two
   rows -- which the schema already allows by not giving either
   model exclusive claim to a GSTIN or a name.

   A CUSTOMER IS NEVER DELETED. One with any sales history cannot
   be removed without orphaning the quotations, orders, invoices
   and payments that explain where goods and money went; the
   database restricts it and there is no delete endpoint.
   Deactivating is the supported answer.
   ============================================================ */

const SELECT = {
  id: true, code: true, name: true, type: true, gstin: true,
  contactName: true, contactEmail: true, contactPhone: true,
  addressLine: true, city: true, state: true, stateCode: true, postalCode: true,
  shippingAddressLine: true, shippingCity: true, shippingState: true,
  shippingStateCode: true, shippingPostalCode: true,
  paymentTerms: true, creditPeriodDays: true, notes: true, isActive: true,
  websiteCustomerRef: true, createdAt: true, updatedAt: true,
};

export async function list({ search, isActive, type, stateCode, page = 1, pageSize = 50 } = {}) {
  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(isActive === undefined ? {} : { isActive }),
    ...(type && type !== 'all' ? { type } : {}),
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
    prisma.customer.findMany({
      where,
      orderBy: { name: 'asc' },
      skip,
      take,
      select: {
        ...SELECT,
        _count: { select: { salesOrders: true, invoices: true, quotations: true } },
      },
    }),
    prisma.customer.count({ where }),
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
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: {
      ...SELECT,
      _count: { select: { salesOrders: true, invoices: true, quotations: true, salesReturns: true } },
    },
  });
  if (!customer) throw new NotFoundError('Customer');
  return shape(customer);
}

/**
 * What this customer has actually traded.
 *
 * Quotations, orders, invoices and payments side by side: the
 * useful question about a customer is rarely "what did they
 * order" alone -- it is whether what was quoted turned into an
 * order, whether it shipped, and whether it was paid for.
 */
export async function history(id, { page = 1, pageSize = 25 } = {}) {
  const customer = await get(id);
  const take = Math.min(Math.max(Number(pageSize) || 25, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const [orders, total, quotations, invoices, payments, ordered] = await Promise.all([
    prisma.salesOrder.findMany({
      where: { customerId: id },
      orderBy: { orderDate: 'desc' },
      skip,
      take,
      select: {
        id: true, orderNo: true, status: true, orderDate: true, expectedDispatchDate: true,
        grandTotal: true, currency: true, gstTreatment: true,
        warehouse: { select: { id: true, name: true } },
        _count: { select: { lines: true, deliveryChallans: true } },
      },
    }),
    prisma.salesOrder.count({ where: { customerId: id } }),
    prisma.quotation.findMany({
      where: { customerId: id },
      orderBy: { quotationDate: 'desc' },
      take: 10,
      select: { id: true, quotationNo: true, status: true, quotationDate: true, grandTotal: true },
    }),
    prisma.salesInvoice.findMany({
      where: { customerId: id, status: 'POSTED' },
      orderBy: { invoiceDate: 'desc' },
      take: 10,
      select: { id: true, invoiceNo: true, invoiceDate: true, grandTotal: true, dueDate: true },
    }),
    prisma.customerPayment.findMany({
      where: { customerId: id },
      orderBy: { paymentDate: 'desc' },
      take: 10,
      select: { id: true, amount: true, paymentDate: true, method: true, salesInvoice: { select: { invoiceNo: true } } },
    }),
    // Value traded, excluding orders that were called off: a
    // cancelled order is not business the studio did.
    prisma.salesOrder.aggregate({
      where: { customerId: id, status: { notIn: ['DRAFT', 'CANCELLED'] } },
      _sum: { grandTotal: true },
      _count: { _all: true },
    }),
  ]);

  // Outstanding, from posted invoices less what has been paid --
  // derived here rather than stored, for the same reason payment
  // balances are always derived: a stored figure can drift from
  // the rows that produced it.
  const [invoiceTotal, paidTotal] = await Promise.all([
    prisma.salesInvoice.aggregate({
      where: { customerId: id, status: 'POSTED' },
      _sum: { grandTotal: true },
    }),
    prisma.customerPayment.aggregate({
      where: { customerId: id },
      _sum: { amount: true },
    }),
  ]);

  return {
    customer,
    summary: {
      ordersPlaced: ordered._count._all,
      valueOrdered: Number(ordered._sum.grandTotal ?? 0),
      invoiced: Number(invoiceTotal._sum.grandTotal ?? 0),
      paid: Number(paidTotal._sum.amount ?? 0),
      outstanding: Number(invoiceTotal._sum.grandTotal ?? 0) - Number(paidTotal._sum.amount ?? 0),
    },
    orders: orders.map((o) => ({
      id: o.id,
      orderNo: o.orderNo,
      status: o.status,
      orderDate: o.orderDate,
      expectedDispatchDate: o.expectedDispatchDate,
      warehouse: o.warehouse,
      lineCount: o._count.lines,
      dispatchCount: o._count.deliveryChallans,
      gstTreatment: o.gstTreatment,
      grandTotal: Number(o.grandTotal),
      currency: o.currency,
    })),
    recentQuotations: quotations.map((q) => ({
      id: q.id, quotationNo: q.quotationNo, status: q.status,
      quotationDate: q.quotationDate, grandTotal: Number(q.grandTotal),
    })),
    recentInvoices: invoices.map((i) => ({
      id: i.id, invoiceNo: i.invoiceNo, invoiceDate: i.invoiceDate,
      dueDate: i.dueDate, amount: Number(i.grandTotal),
    })),
    recentPayments: payments.map((p) => ({
      id: p.id, amount: Number(p.amount), paymentDate: p.paymentDate,
      method: p.method, invoiceNo: p.salesInvoice.invoiceNo,
    })),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

export async function create(input, actor) {
  await assertCan(actor, 'customer:write');
  const data = await validated(input, null);

  const clash = await prisma.customer.findFirst({
    where: { name: { equals: data.name, mode: 'insensitive' } },
    select: { id: true, name: true, code: true },
  });
  if (clash) {
    throw new ConflictError(
      'A customer called "' + clash.name + '" already exists (' + clash.code + '). '
      + 'Two rows for one customer split its history in half.',
      { existingId: clash.id, code: clash.code },
    );
  }

  const wanted = normaliseCode(input.code)
    || normaliseCode('CUS-' + data.name).slice(0, 10)
    || 'CUS';

  return prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: { ...data, code: await freeCode(tx, wanted) },
      select: SELECT,
    });

    await record(tx, {
      entityType: 'Customer',
      entityId: customer.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: customer.name, code: customer.code, gstin: customer.gstin, type: customer.type },
      summary: 'Created customer ' + customer.name + ' (' + customer.code + ')',
    });

    return shape(customer);
  });
}

export async function update(id, input, actor) {
  await assertCan(actor, 'customer:write');

  const before = await prisma.customer.findUnique({ where: { id }, select: SELECT });
  if (!before) throw new NotFoundError('Customer');

  const data = await validated(input, before);

  if (data.name && data.name.toLowerCase() !== before.name.toLowerCase()) {
    const clash = await prisma.customer.findFirst({
      where: { name: { equals: data.name, mode: 'insensitive' }, id: { not: id } },
      select: { name: true, code: true },
    });
    if (clash) {
      throw new ConflictError('Another customer is already called "' + clash.name + '" (' + clash.code + ').');
    }
  }

  // THE CODE IS QUOTED ON INVOICES AND GROUPED ON IN REPORTS.
  // Changing it after the customer has traded renames history.
  if (input.code !== undefined && normaliseCode(input.code) !== before.code) {
    const traded = await prisma.salesOrder.count({ where: { customerId: id } });
    if (traded > 0) {
      throw new ConflictError(
        'This customer code cannot be changed: ' + traded + ' sales order(s) already quote it.',
        { currentCode: before.code, orders: traded },
      );
    }
    data.code = normaliseCode(input.code);
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.customer.update({ where: { id }, data, select: SELECT });
    await record(tx, {
      entityType: 'Customer',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated customer ' + after.name,
    });
    return shape(after);
  });
}

/**
 * Activate or deactivate. NEVER DELETE.
 *
 * A deactivated customer keeps every quotation, order, invoice and
 * payment it ever had; it simply cannot be chosen for a new
 * document. Deleting it would orphan that history, and the
 * database refuses it anyway.
 */
export async function setActive(id, isActive, actor, reason) {
  await assertCan(actor, 'customer:write');

  const customer = await prisma.customer.findUnique({ where: { id }, select: SELECT });
  if (!customer) throw new NotFoundError('Customer');

  if (!isActive) {
    // An order still in flight is the thing worth stopping. Once
    // the customer is inactive nobody can raise a new document for
    // them, but stock already reserved or dispatched has to be
    // resolved first.
    const open = await prisma.salesOrder.count({
      where: {
        customerId: id,
        status: { in: ['PENDING_APPROVAL', 'CONFIRMED', 'PARTIALLY_RESERVED', 'RESERVED', 'PARTIALLY_DISPATCHED'] },
      },
    });
    if (open > 0) {
      throw new ConflictError(
        customer.name + ' has ' + open + ' sales order(s) still open. '
        + 'Dispatch, close or cancel them first.',
        { openOrders: open },
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.customer.update({ where: { id }, data: { isActive }, select: SELECT });
    await record(tx, {
      entityType: 'Customer',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before: { isActive: customer.isActive },
      after: { isActive },
      summary: (isActive ? 'Activated ' : 'Deactivated ') + customer.name
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
    if (!name) fields.push({ field: 'name', message: 'A customer needs a name.' });
    else data.name = name;
  }

  if (input.type !== undefined) {
    if (!['RETAIL', 'TRADE', 'PROJECT', 'INTERNAL'].includes(input.type)) {
      fields.push({ field: 'type', message: 'Not a recognised customer type.' });
    } else {
      data.type = input.type;
    }
  }

  const gstin = input.gstin === undefined ? existing?.gstin : (String(input.gstin ?? '').trim().toUpperCase() || null);
  if (input.gstin !== undefined) data.gstin = gstin;

  // Same fifteen-character shape checked on the supplier side.
  // An unregistered (B2C) customer legitimately has none.
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

  // THE BILLING STATE CODE IS DERIVED FROM THE GSTIN when there is
  // one, exactly as on the supplier side. The shipping state code
  // is NOT derived from it -- shipping is a geographic fact about
  // where goods are delivered, independent of where the customer
  // is registered.
  const merged = { gstin, stateCode: data.stateCode ?? existing?.stateCode ?? null };
  if (gstin && stateCodeDisagreesWithGstin(merged)) {
    fields.push({
      field: 'stateCode',
      message: 'This state code (' + merged.stateCode + ') contradicts the GSTIN, which begins '
        + String(gstin).slice(0, 2) + '. One of the two is a typing error, and the tax on every '
        + 'sale to this customer depends on which.',
    });
  }
  if (gstin && !merged.stateCode) data.stateCode = String(gstin).slice(0, 2);

  if (fields.length) throw new ValidationError(fields);
  return data;
}

function shape(c) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    type: c.type,
    gstin: c.gstin,
    contact: {
      name: c.contactName,
      email: c.contactEmail,
      phone: c.contactPhone,
    },
    billing: {
      addressLine: c.addressLine,
      city: c.city,
      state: c.state,
      stateCode: c.stateCode,
      postalCode: c.postalCode,
    },
    shipping: {
      addressLine: c.shippingAddressLine,
      city: c.shippingCity,
      state: c.shippingState,
      stateCode: c.shippingStateCode,
      postalCode: c.shippingPostalCode,
    },
    paymentTerms: c.paymentTerms,
    creditPeriodDays: c.creditPeriodDays,
    notes: c.notes,
    isActive: c.isActive,
    websiteCustomerRef: c.websiteCustomerRef,
    orderCount: c._count?.salesOrders ?? null,
    invoiceCount: c._count?.invoices ?? null,
    quotationCount: c._count?.quotations ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

async function freeCode(tx, wanted) {
  let code = wanted;
  for (let n = 2; n < 100; n += 1) {
    const taken = await tx.customer.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
    code = wanted.slice(0, 8) + n;
  }
  throw new ConflictError('Could not allocate a customer code.');
}

/** One line per customer, for a dropdown. */
export async function options() {
  const rows = await prisma.customer.findMany({
    where: { isActive: true },
    orderBy: { name: 'asc' },
    select: {
      id: true, code: true, name: true, type: true, gstin: true,
      stateCode: true, state: true, shippingStateCode: true, shippingState: true,
      paymentTerms: true, creditPeriodDays: true,
      addressLine: true, city: true, postalCode: true,
      shippingAddressLine: true, shippingCity: true, shippingPostalCode: true,
    },
  });
  return { rows };
}
