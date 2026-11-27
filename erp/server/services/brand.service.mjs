import { prisma } from '../../db/client.mjs';
import { normaliseName, normaliseCode, similarity, REVIEW_THRESHOLD } from './normalise.mjs';
import { record } from './audit.mjs';
import { ValidationError, NotFoundError, ConflictError, NeedsReviewError } from '../errors.mjs';

/* ============================================================
   BRANDS
   ============================================================
   One brand holds many Product Heads. The work here is almost
   entirely about NOT creating the same brand twice: the damage
   from a split brand is slow and invisible -- every report is
   quietly wrong and nobody notices for months.
   ============================================================ */

export async function list({ search, isActive, page = 1, pageSize = 50 } = {}) {
  const where = {
    ...(isActive === undefined ? {} : { isActive }),
    ...(search
      ? { OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ] }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.brand.findMany({
      where,
      orderBy: { name: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { products: true, collections: true } } },
    }),
    prisma.brand.count({ where }),
  ]);

  return {
    rows: rows.map(shape),
    page,
    pageSize,
    total,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export async function get(id) {
  const brand = await prisma.brand.findUnique({
    where: { id },
    include: { _count: { select: { products: true, collections: true } } },
  });
  if (!brand) throw new NotFoundError('Brand');
  return shape(brand);
}

/**
 * Near-matches for a proposed brand name.
 *
 * An exact normalised match is a hard stop. Anything merely CLOSE
 * is returned for a person to judge: "Somany" and "Somany
 * Ceramics" may be one brand or two, and that is a commercial
 * fact the software does not have.
 */
export async function findSimilar(name, excludeId) {
  const wanted = normaliseName(name);
  if (!wanted) return [];
  const all = await prisma.brand.findMany({ select: { id: true, name: true, isActive: true } });
  return all
    .filter((b) => b.id !== excludeId)
    .map((b) => ({ ...b, score: similarity(wanted, b.name) }))
    .filter((b) => b.score >= REVIEW_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

export async function create({ name, code, logoUrl, description, isActive = true, confirmDistinct = false }, actor) {
  const fields = [];
  if (!String(name ?? '').trim()) fields.push({ field: 'name', message: 'Brand name is required.' });
  if (fields.length) throw new ValidationError(fields);

  const cleanName = String(name).replace(/\s+/g, ' ').trim();
  const cleanCode = normaliseCode(code) || normaliseCode(cleanName).slice(0, 6) || 'BRAND';

  // Exact duplicate, ignoring case and spacing. Refused outright:
  // there is no judgement to make.
  const existing = await prisma.brand.findFirst({
    where: { name: { equals: cleanName, mode: 'insensitive' } },
  });
  if (existing) {
    throw new ConflictError('A brand called "' + existing.name + '" already exists.', {
      existingId: existing.id, existingName: existing.name,
    });
  }

  if (!confirmDistinct) {
    const similar = await findSimilar(cleanName);
    if (similar.length > 0) {
      throw new NeedsReviewError(
        '"' + cleanName + '" looks like a brand that already exists.',
        similar,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    let brand;
    try {
      brand = await tx.brand.create({
        data: {
          name: cleanName, code: await freeCode(tx, cleanCode), isActive,
          logoUrl: logoUrl ?? null, description: description ?? null,
        },
      });
    } catch (err) {
      // The expression index caught something the check above did
      // not — two requests in the same instant. Correct outcome.
      if (err.code === 'P2002') {
        throw new ConflictError('A brand with this name was just created by someone else.');
      }
      throw err;
    }

    await record(tx, {
      entityType: 'Brand',
      entityId: brand.id,
      action: 'CREATE',
      actorUserId: actor?.id,
      after: { name: brand.name, code: brand.code, isActive: brand.isActive },
      summary: 'Created brand ' + brand.name,
    });

    return shape({ ...brand, _count: { products: 0, collections: 0 } });
  });
}

export async function update(id, patch, actor) {
  const before = await prisma.brand.findUnique({ where: { id } });
  if (!before) throw new NotFoundError('Brand');

  const data = {};
  if (patch.name !== undefined) {
    const cleanName = String(patch.name).replace(/\s+/g, ' ').trim();
    if (!cleanName) throw new ValidationError([{ field: 'name', message: 'Brand name is required.' }]);
    if (normaliseName(cleanName) !== normaliseName(before.name)) {
      const clash = await prisma.brand.findFirst({
        where: { name: { equals: cleanName, mode: 'insensitive' }, id: { not: id } },
      });
      if (clash) throw new ConflictError('Another brand is already called "' + clash.name + '".');
    }
    data.name = cleanName;
  }
  if (patch.isActive !== undefined) data.isActive = patch.isActive;
  if (patch.logoUrl !== undefined) data.logoUrl = patch.logoUrl;
  if (patch.description !== undefined) data.description = patch.description;
  // `code` is deliberately NOT editable. It is woven into every
  // SKU generated under this brand, and changing it would make the
  // existing codes describe a prefix that no longer exists.
  if (patch.code !== undefined && normaliseCode(patch.code) !== before.code) {
    throw new ConflictError(
      'A brand code cannot be changed: it is part of every SKU already issued under this brand.',
      { currentCode: before.code },
    );
  }

  return prisma.$transaction(async (tx) => {
    const after = await tx.brand.update({ where: { id }, data });
    await record(tx, {
      entityType: 'Brand',
      entityId: id,
      action: 'UPDATE',
      actorUserId: actor?.id,
      before,
      after,
      summary: 'Updated brand ' + after.name,
    });
    return shape({ ...after, _count: { products: 0, collections: 0 } });
  });
}

/** Activate or deactivate. Brands are never deleted: products,
 *  orders and SKUs all point at them. */
export async function setActive(id, isActive, actor) {
  return update(id, { isActive }, actor);
}

function shape(brand) {
  return {
    id: brand.id,
    code: brand.code,
    name: brand.name,
    logoUrl: brand.logoUrl ?? null,
    description: brand.description ?? null,
    isActive: brand.isActive,
    productCount: brand._count?.products ?? 0,
    productHeadCount: brand._count?.collections ?? 0,
    createdAt: brand.createdAt,
    updatedAt: brand.updatedAt,
  };
}

/** A code nobody else holds, since the column is unique. */
async function freeCode(tx, wanted) {
  let code = wanted;
  for (let n = 2; n < 50; n += 1) {
    const taken = await tx.brand.findUnique({ where: { code }, select: { id: true } });
    if (!taken) return code;
    code = wanted.slice(0, 5) + n;
  }
  throw new ConflictError('Could not allocate a brand code.');
}
