import { createHash } from 'node:crypto';
import { prisma } from '../../db/client.mjs';
import { normaliseName } from '../services/normalise.mjs';

/* ============================================================
   IS THIS ALREADY IN THE ERP?
   ============================================================

   CONSERVATIVE BY DESIGN. Every rule here either proves a match
   or hands the decision to a person. Nothing is merged because
   two names look alike, and nothing independently trackable is
   collapsed: a 600x1200 and an 800x1600 of the same tile are two
   products, and so are the matte and the glossy.

   The cost of being wrong runs one way. A duplicate the studio
   has to merge is an afternoon's annoyance; two variants silently
   merged is stock, orders and history attached to a product that
   no longer distinguishes what was actually sold.
   ============================================================ */

/**
 * THE FINGERPRINT OF A SOURCE ROW.
 *
 * Built from the fields that say WHICH product this is, each
 * normalised the way the duplicate check normalises it. A
 * changed note, a re-extracted image or a new AI tone does not
 * change it — so re-importing an updated sheet recognises the
 * rows it has already seen instead of loading them again.
 *
 * It deliberately EXCLUDES the pipeline's own Product ID. That id
 * is brand + catalogue + image index, so the same tile
 * photographed twice has two of them; keying on it would make
 * every re-photograph a new product.
 */
export function rowFingerprint(mapped) {
  const parts = [
    normaliseName(mapped.brandName ?? ''),
    normaliseName(mapped.name ?? ''),
    normaliseName(mapped.size ?? ''),
    normaliseName(mapped.colour ?? ''),
    normaliseName(mapped.finish ?? ''),
    mapped.thicknessMm === null || mapped.thicknessMm === undefined ? '' : String(mapped.thicknessMm),
  ];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

/**
 * Classify one mapped row against what the ERP already holds.
 *
 * Returns { classification, matchedProductId, reason, candidates }.
 */
export async function classify(mapped, { batchId } = {}) {
  // ── 1. the source's own SKU, if it has one ───────────────
  if (mapped.sourceSku) {
    const bySku = await prisma.product.findUnique({
      where: { sku: mapped.sourceSku.toUpperCase() },
      select: { id: true, sku: true, name: true, size: true, colour: true, finish: true },
    });
    if (bySku) {
      return {
        classification: 'EXISTING_RECORD',
        matchedProductId: bySku.id,
        reason: 'The source SKU ' + bySku.sku + ' is already in the ERP.',
        candidates: [bySku],
      };
    }
  }

  // ── 2. has a previous batch already imported this row? ───
  //
  // The fingerprint is the same across batches, so re-uploading
  // last month's sheet finds the rows it loaded then. This is
  // what makes the whole import idempotent.
  const fingerprint = rowFingerprint(mapped);
  const seen = await prisma.importRow.findFirst({
    where: {
      fingerprint,
      status: 'IMPORTED',
      ...(batchId ? { batchId: { not: batchId } } : {}),
    },
    orderBy: { processedAt: 'desc' },
    select: {
      createdProductId: true,
      batch: { select: { batchNo: true, startedAt: true } },
      createdProduct: { select: { id: true, sku: true, name: true, archivedAt: true } },
    },
  });
  if (seen?.createdProduct) {
    return {
      classification: 'EXACT_DUPLICATE',
      matchedProductId: seen.createdProduct.id,
      reason: 'This exact row was imported by batch ' + seen.batch.batchNo
        + ' as ' + seen.createdProduct.sku + '.',
      candidates: [seen.createdProduct],
    };
  }

  // ── 3. a product with the same identifying attributes ────
  //
  // Brand, name, size, colour, finish and thickness all equal,
  // ignoring case and spacing. That is not a resemblance; it is
  // the same product described twice.
  if (mapped.brandName && mapped.name && mapped.size) {
    const sameBrand = await prisma.product.findMany({
      where: {
        brand: { name: { equals: mapped.brandName, mode: 'insensitive' } },
        name: { equals: mapped.name, mode: 'insensitive' },
      },
      select: {
        id: true, sku: true, name: true, size: true, colour: true,
        finish: true, thicknessMm: true, archivedAt: true,
      },
    });

    const same = (a, b) => normaliseName(a ?? '') === normaliseName(b ?? '');

    const exact = sameBrand.find((p) =>
      same(p.size, mapped.size)
      && same(p.colour, mapped.colour)
      && same(p.finish, mapped.finish)
      && String(p.thicknessMm ?? '') === String(mapped.thicknessMm ?? ''));

    if (exact) {
      return {
        classification: 'EXACT_DUPLICATE',
        matchedProductId: exact.id,
        reason: 'Brand, name, size, colour, finish and thickness all match ' + exact.sku + '.',
        candidates: [exact],
      };
    }

    /* SAME NAME, DIFFERENT ATTRIBUTES.
       This is the one that must NOT be auto-merged. "Adobe Grey"
       in 600x1200 and "Adobe Grey" in 800x1600 are two products
       the studio stocks, prices and sells separately. They are
       surfaced so a person can confirm, and the difference is
       spelled out so confirming takes a glance. */
    if (sameBrand.length > 0) {
      return {
        classification: 'POSSIBLE_DUPLICATE',
        matchedProductId: null,
        reason: 'Same brand and product name, but a different '
          + describeDifference(sameBrand[0], mapped) + '. '
          + 'That is usually a separate variant — confirm before importing.',
        candidates: sameBrand.slice(0, 5).map((p) => ({
          id: p.id, sku: p.sku, name: p.name,
          size: p.size, colour: p.colour, finish: p.finish,
        })),
      };
    }
  }

  return { classification: 'NEW_RECORD', matchedProductId: null, reason: null, candidates: [] };
}

/** Which attribute actually differs, named for the reviewer. */
function describeDifference(existing, mapped) {
  const same = (a, b) => normaliseName(a ?? '') === normaliseName(b ?? '');
  const differs = [];
  if (!same(existing.size, mapped.size)) differs.push('size');
  if (!same(existing.colour, mapped.colour)) differs.push('colour');
  if (!same(existing.finish, mapped.finish)) differs.push('finish');
  if (String(existing.thicknessMm ?? '') !== String(mapped.thicknessMm ?? '')) differs.push('thickness');
  return differs.length ? differs.join(' and ') : 'attribute';
}
