import { prisma } from '../../db/client.mjs';
import {
  postStockMovement, reverseStockMovement, nextDocumentNumber,
  DuplicateMovementError, InsufficientStockError, StockValidationError,
} from '../../db/stock.mjs';
import { record } from './audit.mjs';
import { AppError, NotFoundError, ConflictError, ValidationError } from '../errors.mjs';

/* ============================================================
   INVENTORY OPERATIONS
   ============================================================
   Everything here is a thin, named wrapper over the one stock
   service in db/stock.mjs. The wrappers exist to give each
   operation its own vocabulary, its own required reason and its
   own audit line — not to offer a second way to move stock.
   There isn't one.
   ============================================================ */

export { DuplicateMovementError, InsufficientStockError, StockValidationError };

/* ── balances and overview ───────────────────────────────── */

const BALANCE_SELECT = {
  id: true,
  quantityOnHand: true,
  quantityReserved: true,
  quantityDamaged: true,
  quantityInTransit: true,
  reorderLevel: true,
  lastMovementAt: true,
  product: {
    select: {
      id: true, sku: true, name: true, uom: true, status: true, reorderLevel: true,
      brand: { select: { id: true, name: true } },
      collection: { select: { id: true, name: true } },
      category: { select: { id: true, name: true, code: true } },
    },
  },
  warehouse: { select: { id: true, code: true, name: true, city: true, isActive: true } },
};

function shapeBalance(b) {
  const onHand = Number(b.quantityOnHand);
  const reserved = Number(b.quantityReserved);
  const damaged = Number(b.quantityDamaged);
  const inTransit = Number(b.quantityInTransit);
  const reorderLevel = b.reorderLevel === null
    ? Number(b.product.reorderLevel)
    : Number(b.reorderLevel);

  const available = onHand - reserved - damaged;

  return {
    productId: b.product.id,
    sku: b.product.sku,
    name: b.product.name,
    uom: b.product.uom,
    productStatus: b.product.status,
    brand: b.product.brand,
    productHead: b.product.collection,
    category: b.product.category,
    warehouse: b.warehouse,
    physical: onHand,
    reserved,
    damaged,
    inTransit,
    available,
    reorderLevel,
    /* Derived on read, never stored. A product is low or out as a
       fact about today's inventory, not as a decision anybody
       made about the product. */
    isLowStock: available > 0 && available <= reorderLevel,
    isOutOfStock: available <= 0,
    lastMovementAt: b.lastMovementAt,
  };
}

export async function listStock(query = {}) {
  const {
    search, warehouseId, brandId, categoryId, headId,
    lowOnly, outOnly, damagedOnly,
    sortBy = 'sku', sortDir = 'asc', page = 1, pageSize = 50,
  } = query;

  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(warehouseId ? { warehouseId } : {}),
    ...(damagedOnly ? { quantityDamaged: { gt: 0 } } : {}),
    product: {
      archivedAt: null,
      ...(brandId ? { brandId } : {}),
      ...(categoryId ? { categoryId } : {}),
      ...(headId ? { collectionId: headId } : {}),
      ...(search
        ? {
          OR: [
            { sku: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { brand: { name: { contains: search, mode: 'insensitive' } } },
            { collection: { name: { contains: search, mode: 'insensitive' } } },
          ],
        }
        : {}),
    },
  };

  const orderBy = sortBy === 'physical' ? { quantityOnHand: sortDir }
    : sortBy === 'name' ? { product: { name: sortDir } }
      : { product: { sku: sortDir } };

  const [rows, total] = await Promise.all([
    prisma.inventoryBalance.findMany({ where, orderBy, skip, take, select: BALANCE_SELECT }),
    prisma.inventoryBalance.count({ where }),
  ]);

  let shaped = rows.map(shapeBalance);
  /* Low and out are DERIVED, so they cannot be filtered in SQL
     without duplicating the formula there. Filtered after the
     page is read, and the count is corrected to match — an
     honest smaller page beats a page count that lies. */
  if (lowOnly) shaped = shaped.filter((r) => r.isLowStock);
  if (outOnly) shaped = shaped.filter((r) => r.isOutOfStock);

  return {
    rows: shaped,
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total: (lowOnly || outOnly) ? shaped.length : total,
    pageCount: Math.max(1, Math.ceil(((lowOnly || outOnly) ? shaped.length : total) / take)),
    filteredAfterPaging: Boolean(lowOnly || outOnly),
  };
}

/** Company-wide totals, straight from the view. */
export async function companyTotals() {
  const [row] = await prisma.$queryRaw`SELECT * FROM v_company_stock`;
  return {
    skusHeld: Number(row.skus_held),
    warehousesUsed: Number(row.warehouses_used),
    physicalOnHand: Number(row.physical_on_hand),
    inTransit: Number(row.in_transit),
    /* on hand + in transit. Constant across a transfer: the
       source's on-hand falls and the destination's in-transit
       rises by the same amount. */
    physicalTotal: Number(row.physical_total),
    reserved: Number(row.reserved),
    damaged: Number(row.damaged),
    available: Number(row.available),
  };
}

/** Everything the inventory dashboard shows, from the database. */
export async function dashboard() {
  const [totals, warehouses, products, balances, recent, recon, transfers] = await Promise.all([
    companyTotals(),
    prisma.warehouse.count({ where: { isActive: true } }),
    prisma.product.count({ where: { archivedAt: null, status: { not: 'INACTIVE' } } }),
    prisma.inventoryBalance.findMany({ select: BALANCE_SELECT }),
    prisma.stockLedgerEntry.findMany({
      orderBy: { entryNo: 'desc' },
      take: 12,
      include: {
        product: { select: { sku: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        createdBy: { select: { name: true } },
      },
    }),
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS drifted FROM v_inventory_reconciliation WHERE NOT reconciled
    `,
    prisma.$queryRaw`
      SELECT COUNT(*)::int AS unbalanced FROM v_transfer_reconciliation WHERE NOT balanced
    `,
  ]);

  const shaped = balances.map(shapeBalance);

  return {
    totals: {
      ...totals,
      totalSkus: products,
      totalWarehouses: warehouses,
      lowStock: shaped.filter((r) => r.isLowStock).length,
      outOfStock: shaped.filter((r) => r.isOutOfStock).length,
    },
    lowStock: shaped.filter((r) => r.isLowStock || r.isOutOfStock)
      .sort((a, b) => a.available - b.available)
      .slice(0, 10),
    recentMovements: recent.map(shapeLedgerRow),
    reconciliation: {
      driftedBalances: recon[0].drifted,
      unbalancedTransfers: transfers[0].unbalanced,
      /* The dashboard says PASSED only when both are zero. A
         status that stays green while a balance has drifted is
         worse than no status at all. */
      status: (recon[0].drifted === 0 && transfers[0].unbalanced === 0) ? 'PASSED' : 'FAILED',
    },
  };
}

/* ── the stock card ──────────────────────────────────────── */

function shapeLedgerRow(e) {
  return {
    id: e.id,
    entryNo: String(e.entryNo),
    at: e.transactionDate,
    recordedAt: e.createdAt,
    sku: e.product?.sku,
    productName: e.product?.name,
    warehouse: e.warehouse?.name,
    warehouseCode: e.warehouse?.code,
    movementType: e.movementType,
    reason: e.reason,
    direction: ['INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN'].includes(e.movementType)
      ? 'IN'
      : ['OUTWARD', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT'].includes(e.movementType)
        ? 'OUT'
        : '—',
    quantity: Number(e.quantity),
    uom: e.uom,
    balanceBefore: Number(e.balanceBefore),
    balanceAfter: Number(e.balanceAfter),
    reservedAfter: Number(e.reservedAfter),
    damagedAfter: Number(e.damagedAfter),
    referenceType: e.referenceType,
    referenceNo: e.referenceNo,
    referenceId: e.referenceId,
    remarks: e.remarks,
    performedBy: e.createdBy?.name ?? null,
    reversalOfEntryId: e.reversalOfEntryId,
  };
}

export async function ledger(query = {}) {
  const {
    productId, sku, search, warehouseId, brandId, headId,
    movementType, direction, reason, referenceNo, performedById,
    from, to, page = 1, pageSize = 50,
  } = query;

  /* IN AND OUT ARE NOT COLUMNS, they are groups of movement
     types, and the Inward and Outward screens are this one ledger
     read in two directions. Listed here rather than in the UI so
     that a receipt which appeared on the Inward screen but not in
     the ledger cannot exist. Reservation and damage movements
     belong to neither: nothing physically arrives or leaves. */
  const DIRECTIONS = {
    IN: ['INWARD', 'ADJUSTMENT_INCREASE', 'TRANSFER_IN'],
    OUT: ['OUTWARD', 'ADJUSTMENT_DECREASE', 'TRANSFER_OUT'],
  };

  const take = Math.min(Math.max(Number(pageSize) || 50, 1), 500);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;

  const where = {
    ...(productId ? { productId } : {}),
    ...(warehouseId ? { warehouseId } : {}),
    ...(movementType ? { movementType } : {}),
    ...(!movementType && DIRECTIONS[direction] ? { movementType: { in: DIRECTIONS[direction] } } : {}),
    ...(reason ? { reason } : {}),
    ...(performedById ? { createdById: performedById } : {}),
    ...(referenceNo ? { referenceNo: { contains: referenceNo, mode: 'insensitive' } } : {}),
    ...(from || to
      ? {
        transactionDate: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        },
      }
      : {}),
    ...(sku || search || brandId || headId
      ? {
        product: {
          ...(sku ? { sku: { equals: sku, mode: 'insensitive' } } : {}),
          ...(brandId ? { brandId } : {}),
          ...(headId ? { collectionId: headId } : {}),
          ...(search
            ? {
              OR: [
                { sku: { contains: search, mode: 'insensitive' } },
                { name: { contains: search, mode: 'insensitive' } },
              ],
            }
            : {}),
        },
      }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.stockLedgerEntry.findMany({
      where,
      // entryNo, not the date: two movements on the same business
      // date still have one unambiguous order, which is the point
      // of a gap-free sequence.
      orderBy: { entryNo: 'desc' },
      skip,
      take,
      include: {
        product: { select: { sku: true, name: true } },
        warehouse: { select: { code: true, name: true } },
        createdBy: { select: { name: true } },
      },
    }),
    prisma.stockLedgerEntry.count({ where }),
  ]);

  return {
    rows: rows.map(shapeLedgerRow),
    page: Math.max(Number(page) || 1, 1),
    pageSize: take,
    total,
    pageCount: Math.max(1, Math.ceil(total / take)),
  };
}

/* ── the operations ──────────────────────────────────────── */

async function resolveSku(productIdOrSku) {
  const byId = /^[0-9a-f-]{36}$/i.test(productIdOrSku)
    ? await prisma.product.findUnique({ where: { id: productIdOrSku }, select: { id: true, sku: true } })
    : null;
  if (byId) return byId;
  const bySku = await prisma.product.findUnique({
    where: { sku: String(productIdOrSku ?? '').toUpperCase() },
    select: { id: true, sku: true },
  });
  if (!bySku) {
    throw new ValidationError([{ field: 'product', message: 'No product with that id or SKU.' }]);
  }
  return bySku;
}

async function audited(operation, result, actor, summary) {
  await record(prisma, {
    entityType: 'StockLedgerEntry',
    entityId: result.entry.id,
    action: 'POST',
    actorUserId: actor?.id,
    summary,
  });
  return {
    operation,
    entryId: result.entry.id,
    entryNo: String(result.entry.entryNo),
    sku: result.sku,
    before: result.before,
    after: result.after,
  };
}

/**
 * OPENING STOCK — once per product per warehouse.
 *
 * A second one is not an opening balance, it is a correction, and
 * it has to be posted as an adjustment so the reason is on the
 * record. A unique index enforces that; this gives the message.
 */
export async function openingStock({ product, warehouseId, quantity, unitCost, remarks, transactionDate }, actor) {
  const { id: productId, sku } = await resolveSku(product);

  const existing = await prisma.stockLedgerEntry.findFirst({
    where: { productId, warehouseId, reason: 'OPENING_STOCK' },
    select: { entryNo: true, quantity: true, transactionDate: true },
  });
  if (existing) {
    throw new ConflictError(
      'Opening stock for ' + sku + ' in this warehouse was already set on '
      + existing.transactionDate.toISOString().slice(0, 10)
      + ' (entry ' + existing.entryNo + ', ' + existing.quantity + '). '
      + 'Post an adjustment to correct it, so the reason is recorded.',
      { entryNo: String(existing.entryNo) },
    );
  }

  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'INWARD',
    reason: 'OPENING_STOCK',
    quantity,
    unitCost,
    referenceType: 'OPENING_BALANCE',
    referenceNo: 'OPENING',
    transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
    remarks: remarks ?? 'Opening balance',
    // One per product per warehouse, for ever. Re-sending the
    // same request cannot create a second.
    idempotencyKey: 'opening:' + productId + ':' + warehouseId,
    createdById: actor.id,
  });

  return audited('OPENING_STOCK', result, actor,
    'Opening stock for ' + sku + ': ' + quantity);
}

/** STOCK INWARD — receiving stock. */
export async function stockInward({
  product, warehouseId, quantity, reason = 'PURCHASE_RECEIPT',
  referenceType = 'MANUAL', referenceId, referenceNo, unitCost, remarks,
  transactionDate, idempotencyKey,
}, actor) {
  const { id: productId, sku } = await resolveSku(product);

  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'INWARD',
    reason,
    quantity,
    unitCost,
    referenceType,
    referenceId,
    referenceNo,
    transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
    remarks,
    idempotencyKey: idempotencyKey ?? ('inward:' + crypto.randomUUID()),
    createdById: actor.id,
  });

  return audited('STOCK_INWARD', result, actor,
    'Received ' + quantity + ' of ' + sku + (referenceNo ? ' against ' + referenceNo : ''));
}

/** STOCK OUTWARD — issuing or dispatching stock. */
export async function stockOutward({
  product, warehouseId, quantity, reason = 'SALES_DISPATCH',
  referenceType = 'MANUAL', referenceId, referenceNo, remarks,
  transactionDate, idempotencyKey,
}, actor) {
  const { id: productId, sku } = await resolveSku(product);

  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'OUTWARD',
    reason,
    quantity,
    referenceType,
    referenceId,
    referenceNo,
    transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
    remarks,
    idempotencyKey: idempotencyKey ?? ('outward:' + crypto.randomUUID()),
    createdById: actor.id,
  });

  return audited('STOCK_OUTWARD', result, actor,
    'Issued ' + quantity + ' of ' + sku + (referenceNo ? ' against ' + referenceNo : ''));
}

/**
 * STOCK ADJUSTMENT — up or down, with a reason that is mandatory.
 *
 * An adjustment with no reason is a number somebody changed, and
 * six months later nobody can say why. The reason is required by
 * the signature, not by a convention.
 */
export async function stockAdjustment({
  product, warehouseId, quantity, direction, reason, remarks, transactionDate, idempotencyKey,
}, actor) {
  if (!remarks || !String(remarks).trim()) {
    throw new ValidationError([{
      field: 'remarks',
      message: 'An adjustment must say why. This is what somebody reads in six months.',
    }]);
  }
  if (!['IN', 'OUT'].includes(direction)) {
    throw new ValidationError([{ field: 'direction', message: 'Must be IN or OUT.' }]);
  }

  const { id: productId, sku } = await resolveSku(product);

  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: direction === 'IN' ? 'ADJUSTMENT_INCREASE' : 'ADJUSTMENT_DECREASE',
    reason: reason ?? 'STOCK_COUNT_CORRECTION',
    quantity,
    referenceType: 'STOCK_ADJUSTMENT',
    referenceNo: 'ADJ',
    transactionDate: transactionDate ? new Date(transactionDate) : new Date(),
    remarks,
    idempotencyKey: idempotencyKey ?? ('adjust:' + crypto.randomUUID()),
    createdById: actor.id,
  });

  return audited('STOCK_ADJUSTMENT', result, actor,
    'Adjusted ' + sku + ' ' + direction + ' by ' + quantity + ': ' + remarks);
}

/** RESERVE stock for a confirmed order. Physical stock does not move. */
export async function reserve({ product, warehouseId, quantity, referenceType = 'MANUAL', referenceId, referenceNo, remarks, idempotencyKey }, actor) {
  const { id: productId, sku } = await resolveSku(product);
  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'RESERVATION',
    reason: 'RESERVATION',
    quantity,
    referenceType,
    referenceId,
    referenceNo,
    remarks,
    idempotencyKey: idempotencyKey ?? ('reserve:' + crypto.randomUUID()),
    createdById: actor.id,
  });
  return audited('RESERVATION', result, actor, 'Reserved ' + quantity + ' of ' + sku);
}

export async function releaseReservation({ product, warehouseId, quantity, referenceType = 'MANUAL', referenceId, referenceNo, remarks, idempotencyKey }, actor) {
  const { id: productId, sku } = await resolveSku(product);
  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'RESERVATION_RELEASE',
    reason: 'RESERVATION_RELEASE',
    quantity,
    referenceType,
    referenceId,
    referenceNo,
    remarks,
    idempotencyKey: idempotencyKey ?? ('release:' + crypto.randomUUID()),
    createdById: actor.id,
  });
  return audited('RESERVATION_RELEASE', result, actor, 'Released ' + quantity + ' of ' + sku);
}

/** Mark stock damaged. It stays on the shelf and stops being sellable. */
export async function markDamaged({ product, warehouseId, quantity, remarks, idempotencyKey }, actor) {
  if (!remarks || !String(remarks).trim()) {
    throw new ValidationError([{ field: 'remarks', message: 'Say what happened to it.' }]);
  }
  const { id: productId, sku } = await resolveSku(product);
  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'DAMAGE',
    reason: 'DAMAGE',
    quantity,
    referenceType: 'MANUAL',
    remarks,
    idempotencyKey: idempotencyKey ?? ('damage:' + crypto.randomUUID()),
    createdById: actor.id,
  });
  return audited('DAMAGE', result, actor, 'Marked ' + quantity + ' of ' + sku + ' damaged: ' + remarks);
}

export async function recoverDamaged({ product, warehouseId, quantity, remarks, idempotencyKey }, actor) {
  const { id: productId, sku } = await resolveSku(product);
  const result = await postStockMovement({
    productId,
    warehouseId,
    movementType: 'DAMAGE_RECOVERY',
    reason: 'DAMAGE_RECOVERY',
    quantity,
    referenceType: 'MANUAL',
    remarks,
    idempotencyKey: idempotencyKey ?? ('recover:' + crypto.randomUUID()),
    createdById: actor.id,
  });
  return audited('DAMAGE_RECOVERY', result, actor, 'Recovered ' + quantity + ' of ' + sku);
}

export { reverseStockMovement, nextDocumentNumber };
