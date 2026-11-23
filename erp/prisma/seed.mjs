import { prisma, disconnect } from '../db/client.mjs';
import { postStockMovement, nextDocumentNumber } from '../db/stock.mjs';

/* ============================================================
   DEVELOPMENT SEED
   ============================================================

   SAFE: it only ever upserts by a natural key, so running it twice
   changes nothing the second time. It never truncates, never drops
   and never deletes. On a database that already holds stock it adds
   none, because every movement carries a fixed idempotency key.

   THE RULE IT KEEPS, which is the whole reason the seed is written
   this way: opening stock is POSTED THROUGH THE LEDGER, with
   postStockMovement(), exactly as a real receipt would be. It does
   not write quantityOnHand.

   Writing the quantities directly would have been four lines
   shorter and would have produced a database whose balances no
   ledger explains -- the precise failure the prototype's demo data
   had, and the reason v_inventory_reconciliation exists. A seed
   that cheats teaches everyone who reads it that cheating is
   available.
   ============================================================ */

const log = (...a) => console.log('   ', ...a);

async function main() {
  console.log('\nSeeding the ERP development database\n');

  // ── roles and permissions ──────────────────────────────────
  const ROLES = [
    ['ADMIN', 'Administrator', 'Everything, including users and settings.', ['*']],
    ['MANAGER', 'Studio Manager',
      'Catalogue, stock, purchase and sales. Not users.',
      ['product:read', 'product:write', 'stock:read', 'stock:post',
        // purchase:approve is what lets a manager turn a draft
        // order into one a supplier may act on. Separate from
        // purchase:write on purpose: raising an order and
        // committing the studio to it are different acts, and a
        // role can be given the first without the second.
        'purchase:read', 'purchase:write', 'purchase:approve',
        // THE SALES PERMISSIONS, EACH ITS OWN AUTHORITY. The
        // brief is explicit: order approval, stock reservation,
        // dispatch and payment are separate permissions, and
        // nobody gets unrestricted sales access. The manager
        // holds every one of them; the SALES and STORE roles
        // below each hold a deliberately narrower slice.
        'customer:read', 'customer:write',
        'quotation:read', 'quotation:write', 'quotation:approve',
        'sales:read', 'sales:write', 'sales:approve',
        'stock:reserve', 'sales:invoice', 'sales:dispatch',
        'sales:return', 'sales:payment',
        'report:read']],
    ['STORE', 'Store Keeper',
      'Stock movements and the ledger. Receives goods and dispatches sales orders; approves neither.',
      ['stock:read', 'stock:post', 'product:read',
        // A store keeper books in what arrives at the gate, which
        // is purchase:receive, and can read the order to check it
        // against. Approving one is somebody else's job.
        'purchase:read', 'purchase:receive',
        // The mirror image on the sales side: a store keeper
        // reserves stock for a confirmed order and loads the
        // lorry (sales:dispatch), but does not confirm the order,
        // invoice it or take payment for it.
        'sales:read', 'customer:read', 'stock:reserve', 'sales:dispatch']],
    ['SALES', 'Sales',
      'Quotations and draft orders; commits neither stock nor the studio.',
      ['sales:read', 'sales:write', 'customer:read', 'customer:write',
        'quotation:read', 'quotation:write',
        // Explicitly NOT sales:approve, stock:reserve,
        // sales:dispatch, sales:invoice or sales:payment: a sales
        // person can raise a quotation and a draft order, but
        // confirming it, taking the stock, shipping it, billing
        // it and collecting for it are each somebody else's
        // decision to make.
        'product:read', 'stock:read']],
    ['VIEWER', 'Viewer', 'Read-only across every module.',
      ['product:read', 'stock:read', 'purchase:read', 'sales:read',
        'customer:read', 'quotation:read', 'report:read']],
  ];

  for (const [code, name, description, permissions] of ROLES) {
    const role = await prisma.role.upsert({
      where: { code },
      update: { name, description },
      create: { code, name, description, isSystem: code === 'ADMIN' },
    });
    for (const permission of permissions) {
      await prisma.rolePermission.upsert({
        where: { roleId_permission: { roleId: role.id, permission } },
        update: {},
        create: { roleId: role.id, permission },
      });
    }
  }
  log(ROLES.length, 'roles with their permissions');

  // ── users ──────────────────────────────────────────────────
  //
  // NO PASSWORDS. Every account is INVITED with passwordHash null,
  // so a seeded database cannot be signed into. A development seed
  // that ships a known password is how a known password reaches
  // production.
  const USERS = [
    ['admin@devyora.local', 'Devyora Admin', 'ADMIN'],
    ['manager@devyora.local', 'Studio Manager', 'MANAGER'],
    ['store@devyora.local', 'Store Keeper', 'STORE'],
    ['sales@devyora.local', 'Sales Desk', 'SALES'],
  ];

  const users = {};
  for (const [email, name, roleCode] of USERS) {
    const user = await prisma.user.upsert({
      where: { email },
      update: { name },
      create: { email, name, status: 'INVITED', passwordHash: null },
    });
    const role = await prisma.role.findUniqueOrThrow({ where: { code: roleCode } });
    await prisma.userRole.upsert({
      where: { userId_roleId: { userId: user.id, roleId: role.id } },
      update: {},
      create: { userId: user.id, roleId: role.id },
    });
    users[roleCode] = user;
  }
  log(USERS.length, 'users (all INVITED, no passwords set)');

  // ── warehouse ──────────────────────────────────────────────
  const warehouse = await prisma.warehouse.upsert({
    where: { code: 'WH-MAIN' },
    update: {
      // The place of supply for everything delivered here, and so
      // half of every purchase's GST treatment.
      state: 'Gujarat',
      stateCode: '24',
    },
    create: {
      code: 'WH-MAIN',
      name: 'Studio Warehouse',
      city: 'Ahmedabad',
      state: 'Gujarat',
      stateCode: '24',
      isDefault: true,
    },
  });
  log('1 warehouse:', warehouse.name);

  // ── categories ─────────────────────────────────────────────
  const CATEGORIES = [
    ['FLOOR', 'Floor Tiles', null, '69072100', 1],
    ['WALL', 'Wall Tiles', null, '69072200', 2],
    ['SANI', 'Sanitaryware', null, '69101000', 3],
    ['SLAB', 'Large Format Slabs', 'FLOOR', '69072300', 1],
    ['OUTDOOR', 'Outdoor / Parking', 'FLOOR', '69072100', 2],
    ['HIGHLIGHT', 'Highlighters', 'WALL', '69072200', 1],
  ];

  const categories = {};
  for (const [code, name, parentCode, hsnCode, sortOrder] of CATEGORIES) {
    categories[code] = await prisma.productCategory.upsert({
      where: { code },
      update: { name, hsnCode, sortOrder },
      create: {
        code, name, hsnCode, sortOrder,
        parentId: parentCode ? categories[parentCode].id : null,
      },
    });
  }
  log(CATEGORIES.length, 'categories (3 top level, 3 sub)');

  // ── brands and collections ─────────────────────────────────
  const BRANDS = [
    ['SOM', 'Somany', ['Verona', 'Statuario', 'Travertino']],
    ['MOR', 'Morson', ['Heritage', 'Slate Form', 'Calacatta']],
    ['SIM', 'Simpolo', ['Onyx Lustre', 'Terrazzo']],
    ['VAR', 'Varmora', ['Emperador', 'Lino Wood']],
  ];

  const collections = {};
  let collectionCount = 0;
  for (const [code, name, series] of BRANDS) {
    const brand = await prisma.brand.upsert({
      where: { code }, update: { name }, create: { code, name },
    });
    for (const seriesName of series) {
      const seriesCode = seriesName.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8);
      collections[code + ':' + seriesName] = await prisma.collection.upsert({
        where: { brandId_code: { brandId: brand.id, code: seriesCode } },
        update: { name: seriesName },
        create: { brandId: brand.id, code: seriesCode, name: seriesName },
      });
      collectionCount += 1;
    }
  }
  log(BRANDS.length, 'brands and', collectionCount, 'collections');

  // ── suppliers and customers ────────────────────────────────
  /* The last one is in RAJASTHAN, deliberately. Every other
     supplier and the studio warehouse are in Gujarat, so without
     it every purchase in the demo data would be intra-state and
     the IGST path would never be seen outside the test suite.
     A tile studio buying marble from Kishangarh is also exactly
     what happens. */
  const SUPPLIERS = [
    ['SUP-SOM', 'Somany Ceramics Ltd.', 'Kadi', '24AAACS1234F1Z5', '30 days', 30, 'Gujarat', '24'],
    ['SUP-MOR', 'Morson Granito', 'Morbi', '24AABCM5678G1Z2', '45 days', 45, 'Gujarat', '24'],
    ['SUP-SIM', 'Simpolo Vitrified Pvt. Ltd.', 'Morbi', '24AADCS9012H1Z9', '30 days', 30, 'Gujarat', '24'],
    ['SUP-VAR', 'Varmora Granito Pvt. Ltd.', 'Rajkot', '24AACCV3456J1Z7', 'Advance', null, 'Gujarat', '24'],
    ['SUP-KIS', 'Kishangarh Marble Traders', 'Kishangarh', '08AAFCK7788L1ZQ', '60 days', 60, 'Rajasthan', '08'],
  ];
  for (const [code, name, city, gstin, paymentTerms, creditPeriodDays, state, stateCode] of SUPPLIERS) {
    await prisma.supplier.upsert({
      where: { code },
      update: { name, state, stateCode, creditPeriodDays },
      create: { code, name, city, gstin, paymentTerms, creditPeriodDays, state, stateCode },
    });
  }

  /* The trade customer is in MAHARASHTRA, deliberately -- every
     other customer and the studio warehouse are in Gujarat, so
     without it every sale in the demo data would be intra-state
     and the IGST path would never be seen outside the test suite.
     A retail buyer has no GSTIN at all: an ordinary unregistered
     (B2C) sale, which still carries GST on the sales side, unlike
     an unregistered purchase supplier. */
  const CUSTOMERS = [
    ['CUS-0001', 'Mehta Residence — Bodakdev', 'RETAIL', null, 'Gujarat', '24', 'Immediate', null],
    ['CUS-0002', 'Shah Interiors LLP', 'TRADE', '27AABCS6789K1Z4', 'Maharashtra', '27', '30 days', 30],
    ['CUS-0003', 'Patel Builders Pvt. Ltd.', 'PROJECT', '24AADCP2345L1Z6', 'Gujarat', '24', '45 days', 45],
    ['CUS-0004', 'Casa De Aurum — Studio Sample', 'INTERNAL', null, 'Gujarat', '24', 'Internal', null],
  ];
  for (const [code, name, type, gstin, state, stateCode, paymentTerms, creditPeriodDays] of CUSTOMERS) {
    await prisma.customer.upsert({
      where: { code },
      update: { name, state, stateCode, creditPeriodDays },
      create: {
        code, name, type, gstin, city: state === 'Maharashtra' ? 'Pune' : 'Ahmedabad',
        state, stateCode, paymentTerms, creditPeriodDays,
      },
    });
  }
  log(SUPPLIERS.length, 'suppliers (4 in Gujarat, 1 in Rajasthan) and',
    CUSTOMERS.length, 'customers (3 in Gujarat, 1 in Maharashtra)');

  // ── products ───────────────────────────────────────────────
  //
  // Every one of the three statuses is represented, because a
  // development database where every product is ACTIVE never
  // exercises the distinction the Product Master is built around.
  // Deliberately NO quantities here: stock arrives below, through
  // the ledger.
  const PRODUCTS = [
    // sku,         name,                  brand, collection,    category,   size,          thick, finish,   colour,    pcs, sqft,  cost, sell,  mrp,  reorder, status
    ['DV-1001', 'Verona Charcoal',        'SOM', 'Verona',      'FLOOR',     '600x600mm',   9.5,  'Matte',   'Charcoal', 4, 15.5,   62,   84,   99,  30, 'ACTIVE'],
    ['DV-1002', 'Verona Grey',            'SOM', 'Verona',      'FLOOR',     '600x600mm',   9.5,  'Matte',   'Grey',     4, 15.5,   60,   81,   96,  30, 'ACTIVE'],
    ['DV-1003', 'Statuario White Slab',   'SOM', 'Statuario',   'SLAB',      '800x1600mm', 12.0,  'Polished','White',    2, 27.5,  186,  248,  292,  12, 'ACTIVE'],
    ['DV-1004', 'Travertino Beige',       'SOM', 'Travertino',  'FLOOR',     '600x1200mm',  9.0,  'Satin',   'Beige',    2, 15.5,   78,  104,  123,  25, 'ACTIVE'],
    ['DV-1005', 'Heritage Green',         'MOR', 'Heritage',    'HIGHLIGHT', '300x600mm',   8.5,  'Glossy',  'Green',    8, 15.5,   91,  129,  152,  18, 'ACTIVE'],
    ['DV-1006', 'Heritage Oxblood',       'MOR', 'Heritage',    'HIGHLIGHT', '300x300mm',   8.5,  'Glossy',  'Oxblood', 11, 10.6,   75,  110,  130,  15, 'ACTIVE'],
    ['DV-1007', 'Slate Form Charcoal',    'MOR', 'Slate Form',  'OUTDOOR',   '300x300mm',  10.0,  'Rustic',  'Charcoal',11, 10.6,   45,   59,   70,  40, 'ACTIVE'],
    ['DV-1008', 'Calacatta White Slab',   'MOR', 'Calacatta',   'SLAB',     '1200x2400mm', 15.0,  'Polished','White',    1, 31.0,  232,  318,  375,   8, 'ACTIVE'],
    ['DV-1009', 'Onyx Lustre Gold',       'SIM', 'Onyx Lustre', 'WALL',      '300x600mm',   8.0,  'Glossy',  'Gold',     8, 15.5,   88,  121,  143,  20, 'ACTIVE'],
    ['DV-1010', 'Terrazzo Cream',         'SIM', 'Terrazzo',    'FLOOR',     '600x600mm',   9.5,  'Matte',   'Cream',    4, 15.5,   66,   89,  105,  30, 'ACTIVE'],
    ['DV-1011', 'Emperador Brown',        'VAR', 'Emperador',   'FLOOR',     '600x1200mm',  9.0,  'Satin',   'Brown',    2, 15.5,   74,   99,  117,  25, 'ACTIVE'],
    ['DV-1012', 'Lino Wood Tan',          'VAR', 'Lino Wood',   'FLOOR',     '200x1200mm',  9.0,  'Rustic',  'Tan',      5, 13.0,   69,   95,  112,  22, 'ACTIVE'],
    // Withdrawn for now, may come back. The prototype's "Draft" is
    // this too: INACTIVE, with a mapping that has never synced.
    ['DV-1013', 'Verona Ivory',           'SOM', 'Verona',      'FLOOR',     '600x600mm',   9.5,  'Matte',   'Ivory',    4, 15.5,   60,   81,   96,  30, 'INACTIVE'],
    // Retired. Stock remains to be cleared, and must NEVER be
    // reordered -- which is exactly why this is not "out of stock".
    ['DV-1014', 'Slate Form Black',       'MOR', 'Slate Form',  'OUTDOOR',   '300x300mm',  10.0,  'Rustic',  'Black',   11, 10.6,   45,   59,   70,   0, 'DISCONTINUED'],
  ];

  const products = {};
  for (const p of PRODUCTS) {
    const [sku, name, brandCode, collectionName, categoryCode, size, thicknessMm,
      finish, colour, piecesPerUnit, areaSqftPerUnit, cost, sell, mrp, reorder, status] = p;

    const brand = await prisma.brand.findUniqueOrThrow({ where: { code: brandCode } });
    const [lengthMm, widthMm] = size.replace('mm', '').split('x').map(Number);

    products[sku] = await prisma.product.upsert({
      where: { sku },
      update: { name, purchasePrice: cost, sellingPrice: sell, mrp, status },
      create: {
        sku, name,
        brandId: brand.id,
        categoryId: categories[categoryCode].id,
        collectionId: collections[brandCode + ':' + collectionName].id,
        size, lengthMm, widthMm, thicknessMm,
        finish, colour,
        uom: 'BOX',
        piecesPerUnit,
        areaSqftPerUnit,
        purchasePrice: cost,
        sellingPrice: sell,
        mrp,
        priceBasis: 'PER_SQFT',
        hsnCode: categories[categoryCode].hsnCode,
        reorderLevel: reorder,
        status,
        createdById: users.ADMIN.id,
        updatedById: users.ADMIN.id,
      },
    });
  }
  log(PRODUCTS.length, 'products (12 active, 1 inactive, 1 discontinued)');

  // ── document sequences ─────────────────────────────────────
  for (const [documentType, prefix] of [
    ['PURCHASE_ORDER', 'PO'],
    ['GOODS_RECEIPT_NOTE', 'GRN'],
    ['PURCHASE_RETURN', 'PR'],
    ['QUOTATION', 'QT'],
    ['SALES_ORDER', 'SO'],
    ['SALES_INVOICE', 'INV'],
    ['DELIVERY_CHALLAN', 'DC'],
    ['SALES_RETURN', 'SR'],
    ['STOCK_ADJUSTMENT', 'ADJ'],
    ['WAREHOUSE_TRANSFER', 'TRF'],
    ['IMPORT_BATCH', 'IMP'],
  ]) {
    await prisma.documentSequence.upsert({
      where: { documentType },
      update: {},
      create: { documentType, prefix, periodKey: '2026', lastNumber: 0, padding: 4 },
    });
  }
  log('11 document sequences');

  // ── OPENING STOCK, THROUGH THE LEDGER ──────────────────────
  //
  // Not a single quantityOnHand is written here. Each of these is
  // a real movement, posted the way a receipt is posted: locked,
  // transactional, idempotent, and leaving a stock card that
  // explains the balance it produced.
  //
  // The chosen quantities exercise all four availability states
  // that v_product_availability derives, so the views can be
  // checked against something other than a uniformly healthy
  // catalogue.
  const OPENING = [
    ['DV-1001', 180], ['DV-1002', 95],  ['DV-1003', 40],  ['DV-1004', 120],
    ['DV-1005', 12],  // below its reorder level of 18 -> LOW_STOCK
    ['DV-1006', 60],  ['DV-1007', 210], ['DV-1008', 18],
    ['DV-1009', 0],   // nothing received      -> OUT_OF_STOCK, still ACTIVE
    ['DV-1010', 88],  ['DV-1011', 64],  ['DV-1012', 36],
    ['DV-1014', 7],   // retired, but stock remains to clear
  ];

  let posted = 0;
  let alreadyThere = 0;
  for (const [sku, qty] of OPENING) {
    if (qty === 0) continue;
    const product = products[sku];
    try {
      await postStockMovement({
        productId: product.id,
        warehouseId: warehouse.id,
        movementType: 'INWARD',
        reason: 'OPENING_STOCK',
        quantity: qty,
        uom: 'BOX',
        unitCost: Number(product.purchasePrice),
        referenceType: 'OPENING_BALANCE',
        referenceNo: 'OPENING-2026',
        transactionDate: new Date('2026-04-01T09:00:00Z'),
        remarks: 'Opening balance at go-live',
        // Fixed, so running the seed again is a no-op rather than a
        // second helping of stock.
        idempotencyKey: 'seed:opening:' + sku,
        createdById: users.ADMIN.id,
      });
      posted += 1;
    } catch (err) {
      if (err.name === 'DuplicateMovementError') { alreadyThere += 1; continue; }
      throw err;
    }
  }
  log(posted, 'opening stock movements posted' + (alreadyThere ? ', ' + alreadyThere + ' already present' : ''));

  // ── website mappings, unsynced ─────────────────────────────
  //
  // Prepared, never connected. Every row is NOT_SYNCED with no
  // external id, which is the honest state: the website has not
  // been told about any of this and the ERP has not asked.
  for (const sku of Object.keys(products)) {
    await prisma.websiteProductMapping.upsert({
      where: { productId: products[sku].id },
      update: {},
      create: {
        productId: products[sku].id,
        skuAtMapping: sku,
        syncStatus: 'NOT_SYNCED',
      },
    });
  }
  log(Object.keys(products).length, 'website mappings (all NOT_SYNCED — nothing is connected)');

  // ── a worked example ───────────────────────────────────────
  const nextPo = await nextDocumentNumber('PURCHASE_ORDER');
  log('next purchase order number would be', nextPo);

  console.log('\nDone.\n');
}

main()
  .catch((err) => { console.error('\nSeed failed:', err); process.exitCode = 1; })
  .finally(disconnect);
