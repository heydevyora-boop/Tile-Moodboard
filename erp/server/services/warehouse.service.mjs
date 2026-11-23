import { prisma } from '../../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../../db/stock.mjs';
import { companyTotals } from './inventory.service.mjs';
import { record } from './audit.mjs';
import { normaliseCode } from './normalise.mjs';
import { ValidationError, NotFoundError, ConflictError } from '../errors.mjs';

/* ============================================================
   WAREHOUSES AND TRANSFERS
   ============================================================ */

/* ── warehouses ──────────────────────────────────────────── */

export async function list({ search, isActive, page = 1, pageSize = 50 } = {}) {
  const where = {
    ...(isActive === undefined ? {} : { isActive }),
    ...(search
      ? { OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { city: { contains: search, mode: 'insensitive' } },
      ] }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.warehouse.findMany({
      where,
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.warehouse.count({ where }),
  ]);

  // The stock each one holds, in one query rather than per row.
  const totals = await prisma.inventoryBalance.groupBy({
    by: ['warehouseId'],
    _sum: {
      quantityOnHand: true, quantityReserved: true,
      quantityDamaged: true, quantityInTransit: true,
    },
    _count: { _all: true },
  });
  const byWarehouse = new Map(totals.map((t) => [t.warehouseId, t]));

  return {
    rows: rows.map((w) => shape(w, byWarehouse.get(w.id))),
    page, pageSize, total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function get(id) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) throw new NotFoundError('Warehouse');

  const [totals, movements] = await Promise.all([
    prisma.inventoryBalance.aggregate({
      where: { warehouseId: id },
      _sum: {
        quantityOnHand: true, quantityReserved: true,
        quantityDamaged: true, quantityInTransit: true,
      },
      _count: { _all: true },
    }),
    prisma.stockLedgerEntry.count({ where: { warehouseId: id } }),
  ]);

  return { ...shape(warehouse, totals), movementCount: movements };
}

export async function create({ name, code, city, state, addressLine, postalCode, isActive = true }, actor) {
  const fields = [];
  if (!String(name ?? '').trim()) fields.push({ field: 'name', message: 'Warehouse name is required.' });
  if (fields.length) throw new ValidationError(fields);

  const cleanName = String(name).replace(/\s+/g, ' ').trim();
  const wanted = normaliseCode(code) || normaliseCode('WH-' + cleanName).slice(0, 10) || 'WH';

  const clash = await prisma.warehouse.findFirst({
    where: { name: { equals: cleanName, mode: 'insensitive' } },
  });
  if (clash) {
    throw new ConflictError('A warehouse called "' + clash.name + '" already exists.');
  }

  return prisma.$transaction(async (tx) => {
    const warehouse = await tx.warehouse.create({
      data: {
        name: cleanName,
        code: await freeCode(tx, wanted),
        city: city ?? null,
        state: state ?? null,
        addressLine: addressLine ?? null,
        postalCode: postalCode ?? null,
        isActive,
        // Never automatically. Exactly one warehouse is the
        // default and a partial unique index enforces it; a new
        // one silently stealing the flag would redirect every
        // receipt that did not name a location.
        isDefault: false,
      },
    });

    await record(tx, {
      entityType: 'Warehouse',
      entityId: warehouse.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: warehouse.name, code: warehouse.code, city: warehouse.city },
      summary: 'Created warehouse ' + warehouse.name,
    });

    return shape(warehouse, null);
  });
}

export async function update(id, patch, actor) {
  const before = await prisma.warehouse.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Warehouse');

  const data = {};
  if (patch.name !== undefined) {
    const cleanName = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!cleanName) throw new ValidationError([{ field: 'name', message: 'Warehouse name is required.' }]);
    const clash = await prisma.warehouse.findFirst({
      where: { name: { equals: cleanName, mode: 'insensitive' }, id: { not: id } },
    });
    if (clash) throw new ConflictError('Another warehouse is already called "' + clash.name + '".');
    data.name = cleanName;
  }
  for (const key of ['city', 'state', 'addressLine', 'postalCode']) {
    if (patch[key] !== undefined) data[key] = patch[key];
  }

  /* The code is woven into nothing yet, but it is what people
     quote on paperwork and what the ledger's reports group by.
     Changing it after stock has moved renames history. */
  if (patch.code !== undefined && normaliseCode(patch.code) !== before.code) {
    const moved = await prisma.stockLedgerEntry.count({ where: { warehouseId: id } });
    if (moved > 0) {
      throw new ConflictError(
        'This warehouse code cannot be changed: ' + moved
        + ' stock movement(s) have already been recorded against it.',
        { currentCode: before.code, movements: moved },
      );
    }
    data.code = normaliseCode(patch.code);
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.warehouse.update({ where: { id }, data });
    await record(tx, {
      entityType: 'Warehouse',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated warehouse ' + after.name,
    });
    return shape(after, null);
  });
}

/**
 * Activate or deactivate.
 *
 * NEVER DELETE. A warehouse with stock movements cannot be
 * removed without orphaning the entries that explain where the
 * stock went, and the database restricts it anyway. Deactivating
 * is the supported answer and it stops new movements cold —
 * postStockMovement refuses an inactive warehouse.
 */
export async function setActive(id, isActive, actor, reason) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) throw new NotFoundError('Warehouse');

  if (!isActive) {
    /* STOCK LEFT BEHIND IS THE REAL RISK. Closing a warehouse
       that still holds boxes makes them unreachable: no movement
       can be posted against it afterwards, including the one
       that would move them out. Refused, with the figure. */
    const held = await prisma.inventoryBalance.aggregate({
      where: { warehouseId: id },
      _sum: { quantityOnHand: true, quantityInTransit: true },
    });
    const onHand = Number(held._sum.quantityOnHand ?? 0);
    const inTransit = Number(held._sum.quantityInTransit ?? 0);

    if (onHand > 0 || inTransit > 0) {
      throw new ConflictError(
        warehouse.name + ' still holds ' + onHand + ' on hand'
        + (inTransit > 0 ? ' and ' + inTransit + ' in transit' : '')
        + '. Transfer or write it off first — once deactivated, no movement '
        + 'can be posted against this warehouse, including the one that would empty it.',
        { onHand, inTransit },
      );
    }

    if (warehouse.isDefault) {
      throw new ConflictError(
        'This is the default warehouse. Make another one the default before deactivating it.',
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.warehouse.update({ where: { id }, data: { isActive } });
    await record(tx, {
      entityType: 'Warehouse',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before: { isActive: warehouse.isActive },
      after: { isActive },
      summary: (isActive ? 'Activated ' : 'Deactivated ') + warehouse.name
        + (reason ? ': ' + reason : ''),
    });
    return shape(after, null);
  });
}

/** Stock held in one warehouse, by product. */
export async function stockIn(id, { page = 1, pageSize = 50 } = {}) {
  const warehouse = await prisma.warehouse.findUnique({ where: { id } });
  if (!warehouse) throw new NotFoundError('Warehouse');

  const [rows, total] = await Promise.all([
    prisma.inventoryBalance.findMany({
      where: { warehouseId: id },
      orderBy: { product: { sku: 'asc' } },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { product: { select: { id: true, sku: true, name: true, uom: true, reorderLevel: true } } },
    }),
    prisma.inventoryBalance.count({ where: { warehouseId: id } }),
  ]);

  return {
    warehouse: shape(warehouse, null),
    rows: rows.map((b) => {
      const onHand = Number(b.quantityOnHand);
      const reserved = Number(b.quantityReserved);
      const damaged = Number(b.quantityDamaged);
      return {
        productId: b.product.id,
        sku: b.product.sku,
        name: b.product.name,
        uom: b.product.uom,
        physical: onHand,
        reserved,
        damaged,
        inTransit: Number(b.quantityInTransit),
        available: onHand - reserved - damaged,
        reorderLevel: b.reorderLevel === null ? Number(b.product.reorderLevel) : Number(b.reorderLevel),
        lastMovementAt: b.lastMovementAt,
      };
    }),
    page, pageSize, total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

function shape(w, totals) {
  const sum = totals?._sum ?? {};
  return {
    id: w.id,
    code: w.code,
    name: w.name,
    city: w.city,
    state: w.state,
    addressLine: w.addressLine,
    postalCode: w.postalCode,
    isDefault: w.isDefault,
    isActive: w.isActive,
    skuCount: totals?._count?._all ?? null,
    physical: Number(sum.quantityOnHand ?? 0),
    reserved: Number(sum.quantityReserved ?? 0),
    damaged: Number(sum.quantityDamaged ?? 0),
    inTransit: Number(sum.quantityInTransit ?? 0),
    available: Number(sum.quantityOnHand ?? 0)
      - Number(sum.quantityReserved ?? 0) - Number(sum.quantityDamaged ?? 0),
    createdAt: w.createdAt,
    updatedAt: w.updatedAt,
  };
}

async function freeCode(tx, wanted) {
  let code = wanted;
  for (let n = 2; n < 50; n += 1) {
    const taken = await tx.warehouse.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
    code = wanted.slice(0, 8) + n;
  }
  throw new ConflictError('Could not allocate a warehouse code.');
}

/* ============================================================
   WAREHOUSE TRANSFERS
   ============================================================

   ONE LOGICAL TRANSFER, TWO LINKED MOVEMENTS.

   Both the TRANSFER_OUT at the source and the TRANSFER_IN at the
   destination carry referenceType = WAREHOUSE_TRANSFER and the
   same referenceId — the transfer's own id. They are not two
   unrelated movements that happen to be the same size:
   v_transfer_reconciliation joins them on that reference and
   reports any transfer whose two sides disagree.

   THE LIFECYCLE

       DRAFT       lines entered, nothing has moved
         |  dispatch
       IN_TRANSIT  source's on-hand down, destination's
         |         in-transit up. Company total UNCHANGED.
         |  receive
       COMPLETED   destination's in-transit down, on-hand up.
                   Company total unchanged again.

       DRAFT -> CANCELLED is free; nothing has moved.
       IN_TRANSIT -> CANCELLED returns the stock to the source,
       because the lorry turned round and somebody has to own
       those boxes.

   WHY IN-TRANSIT IS HELD AGAINST THE DESTINATION: it is where
   the stock is going and where somebody will count it. It is not
   part of either warehouse's on-hand, because a lorry is not a
   shelf and nobody can pick from it. Company-wide physical stock
   is on-hand + in-transit, which is constant at every step —
   nothing is ever counted in two places.
   ============================================================ */

export async function createTransfer({ fromWarehouseId, toWarehouseId, lines, notes }, actor) {
  const fields = [];
  if (!fromWarehouseId) fields.push({ field: 'fromWarehouseId', message: 'Source warehouse is required.' });
  if (!toWarehouseId) fields.push({ field: 'toWarehouseId', message: 'Destination warehouse is required.' });
  if (fromWarehouseId && fromWarehouseId === toWarehouseId) {
    fields.push({ field: 'toWarehouseId', message: 'A transfer must be between two different warehouses.' });
  }
  if (!Array.isArray(lines) || lines.length === 0) {
    fields.push({ field: 'lines', message: 'A transfer needs at least one line.' });
  }
  lines.forEach((l, i) => {
    if (!l?.productId) {
      fields.push({ field: 'lines[' + i + '].productId', message: 'Line ' + (i + 1) + ' has no product.' });
    }
    if (!(Number(l?.quantity) > 0)) {
      fields.push({ field: 'lines[' + i + '].quantity', message: 'Line ' + (i + 1) + ' needs a quantity above zero.' });
    }
  });
  if (fields.length) throw new ValidationError(fields);

  /* Refuse an unknown product HERE, while somebody is still
     looking at the form -- not at dispatch, when the lorry is
     waiting and the error is a foreign-key violation. */
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const known = await prisma.product.findMany({
    where: { id: { in: productIds } }, select: { id: true },
  });
  if (known.length !== productIds.length) {
    const found = new Set(known.map((p) => p.id));
    throw new ValidationError(
      lines
        .map((l, i) => ({ l, i }))
        .filter(({ l }) => !found.has(l.productId))
        .map(({ i }) => ({ field: 'lines[' + i + '].productId', message: 'No such product.' })),
    );
  }

  const [from, to] = await Promise.all([
    prisma.warehouse.findUnique({ where: { id: fromWarehouseId } }),
    prisma.warehouse.findUnique({ where: { id: toWarehouseId } }),
  ]);
  if (!from) throw new ValidationError([{ field: 'fromWarehouseId', message: 'No such warehouse.' }]);
  if (!to) throw new ValidationError([{ field: 'toWarehouseId', message: 'No such warehouse.' }]);
  if (!from.isActive) throw new ValidationError([{ field: 'fromWarehouseId', message: from.name + ' is deactivated.' }]);
  if (!to.isActive) throw new ValidationError([{ field: 'toWarehouseId', message: to.name + ' is deactivated.' }]);

  const transferNo = await nextDocumentNumber('WAREHOUSE_TRANSFER');

  const id = await prisma.$transaction(async (tx) => {
    const transfer = await tx.warehouseTransfer.create({
      data: {
        transferNo,
        fromWarehouseId,
        toWarehouseId,
        status: 'DRAFT',
        notes: notes ?? null,
        createdById: actor.id,
        lines: {
          create: lines.map((l, i) => ({
            lineNo: i + 1,
            productId: l.productId,
            quantity: l.quantity,
            uom: l.uom ?? 'BOX',
          })),
        },
      },
    });

    await record(tx, {
      entityType: 'WarehouseTransfer',
      entityId: transfer.id,
      action: 'CREATE',
      actorUserId: actor.id,
      summary: 'Created transfer ' + transferNo + ' from ' + from.name + ' to ' + to.name
        + ' (' + lines.length + ' line(s)). Nothing has moved yet.',
    });

    return transfer.id;
  });

  // Read it back on its own connection, AFTER the commit. Calling
  // getTransfer inside the transaction would look for a row that
  // has not been committed yet and find nothing.
  return getTransfer(id);
}

/** DISPATCH — stock leaves the source and is in transit. */
export async function dispatchTransfer(id, actor) {
  const transfer = await prisma.warehouseTransfer.findUnique({
    where: { id },
    include: { lines: true, fromWarehouse: true, toWarehouse: true },
  });
  if (!transfer) throw new NotFoundError('Transfer');
  if (transfer.status !== 'DRAFT') {
    throw new ConflictError('Transfer ' + transfer.transferNo + ' is ' + transfer.status
      + ' and cannot be dispatched.');
  }

  await prisma.$transaction(async (tx) => {
    for (const line of transfer.lines) {
      // Out of the source. This checks availability, takes the
      // row lock and refuses an inactive warehouse, like every
      // other movement.
      await postStockMovement({
        productId: line.productId,
        warehouseId: transfer.fromWarehouseId,
        movementType: 'TRANSFER_OUT',
        reason: 'WAREHOUSE_TRANSFER',
        quantity: line.quantity,
        uom: line.uom,
        referenceType: 'WAREHOUSE_TRANSFER',
        referenceId: transfer.id,
        referenceNo: transfer.transferNo,
        remarks: 'To ' + transfer.toWarehouse.name,
        // Derived from the transfer line, so dispatching twice
        // is refused by the same unique constraint that stops
        // any double post.
        idempotencyKey: 'transfer:out:' + line.id,
        createdById: actor.id,
      }, tx);

      /* IN TRANSIT AT THE DESTINATION. Not a ledger movement:
         nothing has arrived, and writing a TRANSFER_IN now would
         make the destination's on-hand include boxes still on a
         lorry. The row is created if the destination has never
         held this product. */
      await tx.$executeRaw`
        INSERT INTO "inventory_balances"
          ("id", "productId", "warehouseId", "quantityOnHand", "quantityReserved",
           "quantityDamaged", "quantityInTransit", "updatedAt")
        VALUES (gen_random_uuid(), ${line.productId}::uuid, ${transfer.toWarehouseId}::uuid,
                0, 0, 0, ${line.quantity}, now())
        ON CONFLICT ("productId", "warehouseId")
        DO UPDATE SET "quantityInTransit" = "inventory_balances"."quantityInTransit" + ${line.quantity},
                      "updatedAt" = now()
      `;
    }

    await tx.warehouseTransfer.update({
      where: { id },
      data: { status: 'IN_TRANSIT', dispatchedAt: new Date(), dispatchedById: actor.id },
    });

    await record(tx, {
      entityType: 'WarehouseTransfer',
      entityId: id,
      action: 'POST',
      actorUserId: actor.id,
      summary: 'Dispatched ' + transfer.transferNo + ' from ' + transfer.fromWarehouse.name
        + '. Stock is in transit to ' + transfer.toWarehouse.name
        + '; company-wide total unchanged.',
    });
  });

  return getTransfer(id);
}

/** RECEIVE — stock arrives and becomes on-hand at the destination. */
export async function receiveTransfer(id, actor) {
  const transfer = await prisma.warehouseTransfer.findUnique({
    where: { id },
    include: { lines: true, fromWarehouse: true, toWarehouse: true },
  });
  if (!transfer) throw new NotFoundError('Transfer');
  if (transfer.status !== 'IN_TRANSIT') {
    throw new ConflictError('Transfer ' + transfer.transferNo + ' is ' + transfer.status
      + ' and cannot be received.');
  }

  await prisma.$transaction(async (tx) => {
    for (const line of transfer.lines) {
      await postStockMovement({
        productId: line.productId,
        warehouseId: transfer.toWarehouseId,
        movementType: 'TRANSFER_IN',
        reason: 'WAREHOUSE_TRANSFER',
        quantity: line.quantity,
        uom: line.uom,
        referenceType: 'WAREHOUSE_TRANSFER',
        referenceId: transfer.id,
        referenceNo: transfer.transferNo,
        remarks: 'From ' + transfer.fromWarehouse.name,
        idempotencyKey: 'transfer:in:' + line.id,
        createdById: actor.id,
        /* A transfer already on its way must be receivable even
           if the destination has since been deactivated.
           Refusing it would strand the stock in transit,
           counted nowhere anybody can act on. */
        allowInactiveWarehouse: true,
      }, tx);

      await tx.$executeRaw`
        UPDATE "inventory_balances"
        SET "quantityInTransit" = "quantityInTransit" - ${line.quantity}, "updatedAt" = now()
        WHERE "productId" = ${line.productId}::uuid AND "warehouseId" = ${transfer.toWarehouseId}::uuid
      `;

      await tx.warehouseTransferLine.update({
        where: { id: line.id },
        data: { receivedQuantity: line.quantity },
      });
    }

    await tx.warehouseTransfer.update({
      where: { id },
      data: { status: 'COMPLETED', receivedAt: new Date(), receivedById: actor.id },
    });

    await record(tx, {
      entityType: 'WarehouseTransfer',
      entityId: id,
      action: 'POST',
      actorUserId: actor.id,
      summary: 'Received ' + transfer.transferNo + ' at ' + transfer.toWarehouse.name + '.',
    });
  });

  return getTransfer(id);
}

/**
 * CANCEL.
 *
 * From DRAFT: free, nothing has moved.
 * From IN_TRANSIT: the stock goes back to the source, because the
 * lorry turned round and those boxes have to belong somewhere.
 * From COMPLETED: refused. The stock has arrived and been
 * counted; undoing it is a new transfer the other way, which is
 * what actually happened.
 */
export async function cancelTransfer(id, actor, reason) {
  const transfer = await prisma.warehouseTransfer.findUnique({
    where: { id },
    include: { lines: true, fromWarehouse: true, toWarehouse: true },
  });
  if (!transfer) throw new NotFoundError('Transfer');

  if (transfer.status === 'COMPLETED') {
    throw new ConflictError(
      'Transfer ' + transfer.transferNo + ' has already been received. '
      + 'Send the stock back as a new transfer — that is what would actually happen.',
    );
  }
  if (transfer.status === 'CANCELLED') {
    throw new ConflictError('Transfer ' + transfer.transferNo + ' is already cancelled.');
  }

  const wasInTransit = transfer.status === 'IN_TRANSIT';

  await prisma.$transaction(async (tx) => {
    if (wasInTransit) {
      for (const line of transfer.lines) {
        // Back to the source, as its own movement. The original
        // dispatch stays on the stock card: the stock did leave,
        // and then it came back.
        await postStockMovement({
          productId: line.productId,
          warehouseId: transfer.fromWarehouseId,
          movementType: 'TRANSFER_IN',
          reason: 'WAREHOUSE_TRANSFER',
          quantity: line.quantity,
          uom: line.uom,
          referenceType: 'WAREHOUSE_TRANSFER',
          referenceId: transfer.id,
          referenceNo: transfer.transferNo,
          remarks: 'Transfer cancelled; returned to ' + transfer.fromWarehouse.name,
          idempotencyKey: 'transfer:cancel:' + line.id,
          createdById: actor.id,
          allowInactiveWarehouse: true,
        }, tx);

        await tx.$executeRaw`
          UPDATE "inventory_balances"
          SET "quantityInTransit" = "quantityInTransit" - ${line.quantity}, "updatedAt" = now()
          WHERE "productId" = ${line.productId}::uuid AND "warehouseId" = ${transfer.toWarehouseId}::uuid
        `;
      }
    }

    await tx.warehouseTransfer.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await record(tx, {
      entityType: 'WarehouseTransfer',
      entityId: id,
      action: 'CANCEL',
      actorUserId: actor.id,
      summary: 'Cancelled ' + transfer.transferNo
        + (wasInTransit ? '. Stock returned to ' + transfer.fromWarehouse.name + '.' : '. Nothing had moved.')
        + (reason ? ' Reason: ' + reason : ''),
    });
  });

  return getTransfer(id);
}

export async function listTransfers({ status, warehouseId, page = 1, pageSize = 50 } = {}) {
  const where = {
    ...(status ? { status } : {}),
    ...(warehouseId
      ? { OR: [{ fromWarehouseId: warehouseId }, { toWarehouseId: warehouseId }] }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.warehouseTransfer.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        fromWarehouse: { select: { id: true, code: true, name: true } },
        toWarehouse: { select: { id: true, code: true, name: true } },
        createdBy: { select: { name: true } },
        dispatchedBy: { select: { name: true } },
        receivedBy: { select: { name: true } },
        _count: { select: { lines: true } },
      },
    }),
    prisma.warehouseTransfer.count({ where }),
  ]);

  return {
    rows: rows.map(shapeTransfer),
    page, pageSize, total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function getTransfer(id) {
  const transfer = await prisma.warehouseTransfer.findUnique({
    where: { id },
    include: {
      fromWarehouse: { select: { id: true, code: true, name: true } },
      toWarehouse: { select: { id: true, code: true, name: true } },
      createdBy: { select: { name: true } },
      dispatchedBy: { select: { name: true } },
      receivedBy: { select: { name: true } },
      _count: { select: { lines: true } },
      lines: {
        orderBy: { lineNo: 'asc' },
        include: { product: { select: { id: true, sku: true, name: true } } },
      },
    },
  });
  if (!transfer) throw new NotFoundError('Transfer');

  // The two sides, compared. A transfer whose dispatch and
  // receipt disagree is stock lost between two of our own doors.
  const [balance] = await prisma.$queryRaw`
    SELECT dispatched_quantity::text AS dispatched, received_quantity::text AS received,
           still_in_transit::text AS in_transit,
           received_at_destination::text AS at_destination,
           returned_to_source::text AS returned, balanced
    FROM v_transfer_reconciliation WHERE transfer_id = ${id}::uuid
  `;

  return {
    ...shapeTransfer(transfer),
    lines: transfer.lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      productId: l.product.id,
      sku: l.product.sku,
      name: l.product.name,
      quantity: Number(l.quantity),
      receivedQuantity: Number(l.receivedQuantity),
      uom: l.uom,
    })),
    movement: balance
      ? {
        dispatched: Number(balance.dispatched),
        received: Number(balance.received),
        stillInTransit: Number(balance.in_transit),
        // Which of these is non-zero says what happened: stock
        // received at the destination completed the transfer;
        // stock returned to the source means it was cancelled on
        // the road.
        receivedAtDestination: Number(balance.at_destination),
        returnedToSource: Number(balance.returned),
        balanced: balance.balanced,
      }
      : null,
  };
}

function shapeTransfer(t) {
  return {
    id: t.id,
    transferNo: t.transferNo,
    status: t.status,
    from: t.fromWarehouse,
    to: t.toWarehouse,
    lineCount: t._count?.lines ?? 0,
    notes: t.notes,
    createdBy: t.createdBy?.name ?? null,
    dispatchedBy: t.dispatchedBy?.name ?? null,
    receivedBy: t.receivedBy?.name ?? null,
    createdAt: t.createdAt,
    dispatchedAt: t.dispatchedAt,
    receivedAt: t.receivedAt,
    cancelledAt: t.cancelledAt,
  };
}

/* ============================================================
   RECONCILIATION REPORT
   ============================================================
   Reports. NEVER repairs. A discrepancy is a question for a
   person, and the answer is an authorised adjustment with a
   reason on it — not a script that quietly makes the numbers
   agree and loses the evidence of what went wrong.
   ============================================================ */

export async function reconciliationReport() {
  const [drifted, negative, missingProjection, unbalancedTransfers, duplicateRefs, company] =
    await Promise.all([
      prisma.$queryRaw`
        SELECT "sku", warehouse_name, projected_quantity::text AS projected,
               ledger_quantity::text AS ledger, difference::text AS difference,
               projected_reserved::text AS projected_reserved,
               ledger_reserved::text AS ledger_reserved,
               projected_damaged::text AS projected_damaged,
               ledger_damaged::text AS ledger_damaged
        FROM v_inventory_reconciliation WHERE NOT reconciled
        ORDER BY "sku"
      `,
      prisma.$queryRaw`
        SELECT "sku", warehouse_name, projected_quantity::text AS on_hand,
               available::text AS available
        FROM v_inventory_reconciliation
        WHERE projected_quantity < 0 OR available < 0
        ORDER BY "sku"
      `,
      /* A product with stock movements but no balance row. The
         projection should be created by the first movement, so
         one of these means something wrote the ledger directly. */
      prisma.$queryRaw`
        SELECT DISTINCT p."sku", w."name" AS warehouse_name
        FROM "stock_ledger_entries" e
        JOIN "products" p ON p."id" = e."productId"
        JOIN "warehouses" w ON w."id" = e."warehouseId"
        LEFT JOIN "inventory_balances" b
          ON b."productId" = e."productId" AND b."warehouseId" = e."warehouseId"
        WHERE b."id" IS NULL
      `,
      prisma.$queryRaw`
        SELECT "transferNo", "status", dispatched_quantity::text AS dispatched,
               received_quantity::text AS received, still_in_transit::text AS in_transit
        FROM v_transfer_reconciliation WHERE NOT balanced
      `,
      /* The same document number posted against one product and
         warehouse more than once. Not always wrong -- a purchase
         order can be received in two deliveries -- so it is
         reported for a person to look at, not flagged as an
         error. */
      prisma.$queryRaw`
        SELECT e."referenceNo", p."sku", COUNT(*)::int AS times
        FROM "stock_ledger_entries" e
        JOIN "products" p ON p."id" = e."productId"
        WHERE e."referenceNo" IS NOT NULL
          AND e."referenceNo" NOT IN ('OPENING', 'ADJ', '—')
        GROUP BY e."referenceNo", p."sku", e."warehouseId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 50
      `,
      companyTotals(),
    ]);

  const problems = drifted.length + negative.length
    + missingProjection.length + unbalancedTransfers.length;

  return {
    status: problems === 0 ? 'PASSED' : 'FAILED',
    checkedAt: new Date(),
    company,
    problems,
    driftedBalances: drifted,
    negativeBalances: negative,
    missingProjections: missingProjection,
    unbalancedTransfers,
    // Informational, not a failure.
    repeatedReferences: duplicateRefs,
    note: problems === 0
      ? 'Every balance matches the ledger that produced it, and every transfer accounts for its stock.'
      : 'Discrepancies found. These are NOT repaired automatically: a correction must be '
        + 'posted as an authorised adjustment with a reason, so the record shows what happened.',
  };
}
