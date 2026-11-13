/**
 * MOVING A SAMPLE, AND WHO IS ALLOWED TO.
 *
 * A sample's FIRST placement is just a fact being recorded -- see
 * sample.service.registerSample. Every placement after that is a MOVE,
 * and a move needs the Admin's agreement, because a piece that has
 * quietly changed panel is a piece nobody can find.
 *
 * So the asking and the doing are two separate acts:
 *
 *   request   floor staff say where a sample should go. Nothing about
 *             the sample's placement changes. A request is an
 *             intention, not an edit.
 *   approve   an Admin agrees, and THAT is what writes the new
 *             placement -- in one transaction with closing the old one.
 *   reject    an Admin declines. The sample stays exactly where it is,
 *             and the refusal is still on the record.
 *
 * THE HISTORY IS COMPLETE BECAUSE NOTHING IS OVERWRITTEN. A relocation
 * inserts a placement row and closes the previous one with an endedAt;
 * it never edits a cassette or panel number in place. "Where was this
 * in March" therefore has an answer, and so does "who moved it, and who
 * let them".
 */

import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { logActivity } from './activityLog.service';

export interface RelocationInput {
  cassetteNo: string;
  panelNo: string;
  reason?: string;
}

/**
 * Ask for a sample to be moved.
 *
 * Open to anyone who may look at the catalogue, deliberately: the
 * people who actually move samples are on the floor, and a request
 * changes nothing until an Admin acts on it. The gate that matters is
 * on approval.
 */
export async function requestRelocation(
  physicalSampleId: string,
  input: RelocationInput,
  userId?: string,
  req?: Request,
) {
  const id = String(physicalSampleId ?? '').trim();
  const toCassetteNo = String(input.cassetteNo ?? '').trim();
  const toPanelNo = String(input.panelNo ?? '').trim();

  if (!toCassetteNo) throw AppError.badRequest('Which cassette should it move to?');
  if (!toPanelNo) throw AppError.badRequest('Which panel should it move to?');

  const sample = await prisma.physicalSample.findUnique({
    where: { id },
    include: {
      placements: { where: { isCurrent: true }, take: 1 },
      colour: { select: { colourName: true } },
    },
  });
  if (!sample) throw AppError.notFound('That sample is not on record.');

  const current = sample.placements[0] ?? null;

  if (current && current.cassetteNo === toCassetteNo && current.panelNo === toPanelNo) {
    throw AppError.badRequest(
      `${sample.sampleId} is already in cassette ${toCassetteNo}, panel ${toPanelNo}.`,
    );
  }

  /* ONE OPEN REQUEST AT A TIME. Two pending moves for one sample is a
     question with two answers: whichever an Admin approves second would
     be acting on a placement that has already changed under it. */
  const pending = await prisma.placementChangeRequest.findFirst({
    where: { physicalSampleId: id, status: 'PENDING' },
  });
  if (pending) {
    throw AppError.badRequest(
      `A move for ${sample.sampleId} is already waiting for the Admin’s approval `
      + `(to cassette ${pending.toCassetteNo}, panel ${pending.toPanelNo}). `
      + 'That one has to be decided first.',
    );
  }

  const request = await prisma.placementChangeRequest.create({
    data: {
      physicalSampleId: id,
      fromPlacementId: current?.id ?? null,
      fromCassetteNo: current?.cassetteNo ?? null,
      fromPanelNo: current?.panelNo ?? null,
      toCassetteNo,
      toPanelNo,
      reason: input.reason?.trim() || null,
      requestedById: userId ?? null,
    },
  });

  await logActivity({
    userId: userId ?? null,
    action: 'sample_placement.requested',
    entityType: 'PlacementChangeRequest',
    entityId: request.id,
    metadata: {
      sampleId: sample.sampleId,
      from: current ? `${current.cassetteNo}/${current.panelNo}` : null,
      to: `${toCassetteNo}/${toPanelNo}`,
    },
    req,
  });

  return request;
}

/** The queue an Admin works through. Newest request last, as a queue is. */
export async function listRequests(status = 'PENDING', page = 1, limit = 25) {
  const wanted = String(status ?? 'PENDING').toUpperCase();
  if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(wanted)) {
    throw AppError.badRequest('status must be PENDING, APPROVED, REJECTED or ALL.');
  }

  const where = wanted === 'ALL'
    ? {}
    : { status: wanted as 'PENDING' | 'APPROVED' | 'REJECTED' };

  const take = Math.min(100, Math.max(1, limit));
  const skip = (Math.max(1, page) - 1) * take;

  // Two queries for a page, not one per request: the sample, its
  // colour, its product and both users come back joined.
  const [rows, total] = await Promise.all([
    prisma.placementChangeRequest.findMany({
      where,
      orderBy: { requestedAt: wanted === 'PENDING' ? 'asc' : 'desc' },
      skip,
      take,
      include: {
        sample: {
          select: {
            id: true,
            sampleId: true,
            barcode: true,
            colour: {
              select: {
                colourName: true,
                product: { select: { id: true, name: true, productCode: true } },
              },
            },
          },
        },
        requestedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.placementChangeRequest.count({ where }),
  ]);

  return {
    requests: rows.map((row) => ({
      id: row.id,
      status: row.status,
      sampleId: row.sample.sampleId,
      barcode: row.sample.barcode,
      physicalSampleId: row.sample.id,
      colourName: row.sample.colour.colourName,
      product: row.sample.colour.product,
      from: row.fromCassetteNo ? { cassetteNo: row.fromCassetteNo, panelNo: row.fromPanelNo } : null,
      to: { cassetteNo: row.toCassetteNo, panelNo: row.toPanelNo },
      reason: row.reason,
      requestedBy: row.requestedBy,
      requestedAt: row.requestedAt,
      decidedBy: row.decidedBy,
      decidedAt: row.decidedAt,
      decisionNote: row.decisionNote,
    })),
    page: Math.max(1, page),
    limit: take,
    total,
    pages: Math.max(1, Math.ceil(total / take)),
  };
}

/**
 * THE MOVE ITSELF, IN ONE TRANSACTION.
 *
 * Closing the old placement, writing the new one and marking the
 * request decided are one act or none. Three separate writes would
 * leave a sample in two panels, or in none, the first time a
 * connection dropped between them -- and a sample in two panels is
 * worse than a sample in the wrong one, because nothing on screen says
 * which is true.
 */
export async function approveRequest(requestId: string, userId: string, note?: string) {
  const id = String(requestId ?? '').trim();

  const result = await prisma.$transaction(async (tx) => {
    const request = await tx.placementChangeRequest.findUnique({
      where: { id },
      include: { sample: { select: { id: true, sampleId: true } } },
    });
    if (!request) throw AppError.notFound('That request is not on record.');
    if (request.status !== 'PENDING') {
      throw AppError.badRequest(
        `That request was already ${request.status.toLowerCase()}.`,
      );
    }

    // The old placement stops being current, and is stamped with when.
    await tx.samplePlacement.updateMany({
      where: { physicalSampleId: request.physicalSampleId, isCurrent: true },
      data: { isCurrent: false, endedAt: new Date() },
    });

    const placement = await tx.samplePlacement.create({
      data: {
        physicalSampleId: request.physicalSampleId,
        cassetteNo: request.toCassetteNo,
        panelNo: request.toPanelNo,
        isCurrent: true,
        placedById: request.requestedById,
        note: request.reason,
      },
    });

    const decided = await tx.placementChangeRequest.update({
      where: { id },
      data: {
        status: 'APPROVED',
        decidedById: userId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || null,
        resultPlacementId: placement.id,
      },
    });

    return { request: decided, placement, sampleId: request.sample.sampleId };
  });

  await logActivity({
    userId,
    action: 'sample_placement.approved',
    entityType: 'PlacementChangeRequest',
    entityId: id,
    metadata: {
      sampleId: result.sampleId,
      to: `${result.placement.cassetteNo}/${result.placement.panelNo}`,
      placementId: result.placement.id,
    },
  });

  return result;
}

/** Decline it. The sample does not move, and the refusal is recorded. */
export async function rejectRequest(requestId: string, userId: string, note?: string) {
  const id = String(requestId ?? '').trim();

  const request = await prisma.placementChangeRequest.findUnique({
    where: { id },
    include: { sample: { select: { sampleId: true } } },
  });
  if (!request) throw AppError.notFound('That request is not on record.');
  if (request.status !== 'PENDING') {
    throw AppError.badRequest(`That request was already ${request.status.toLowerCase()}.`);
  }

  const decided = await prisma.placementChangeRequest.update({
    where: { id },
    data: {
      status: 'REJECTED',
      decidedById: userId,
      decidedAt: new Date(),
      decisionNote: note?.trim() || null,
    },
  });

  await logActivity({
    userId,
    action: 'sample_placement.rejected',
    entityType: 'PlacementChangeRequest',
    entityId: id,
    metadata: {
      sampleId: request.sample.sampleId,
      to: `${request.toCassetteNo}/${request.toPanelNo}`,
    },
  });

  return decided;
}

/**
 * Everywhere this sample has been, and every move ever asked for.
 *
 * Placements newest first, because the question is almost always
 * "where is it now, and where was it before that".
 */
export async function history(physicalSampleId: string) {
  const id = String(physicalSampleId ?? '').trim();

  const sample = await prisma.physicalSample.findUnique({
    where: { id },
    include: {
      colour: {
        select: {
          colourName: true,
          availability: true,
          product: { select: { id: true, name: true, productCode: true } },
        },
      },
      placements: {
        orderBy: { placedAt: 'desc' },
        include: { placedBy: { select: { id: true, name: true } } },
      },
      changeRequests: {
        orderBy: { requestedAt: 'desc' },
        include: {
          requestedBy: { select: { id: true, name: true } },
          decidedBy: { select: { id: true, name: true } },
        },
      },
    },
  });
  if (!sample) throw AppError.notFound('That sample is not on record.');

  return {
    id: sample.id,
    sampleId: sample.sampleId,
    barcode: sample.barcode,
    photoUrl: sample.photoUrl,
    colour: sample.colour,
    placements: sample.placements.map((p) => ({
      id: p.id,
      cassetteNo: p.cassetteNo,
      panelNo: p.panelNo,
      isCurrent: p.isCurrent,
      placedAt: p.placedAt,
      endedAt: p.endedAt,
      placedBy: p.placedBy,
      note: p.note,
    })),
    requests: sample.changeRequests.map((r) => ({
      id: r.id,
      status: r.status,
      from: r.fromCassetteNo ? { cassetteNo: r.fromCassetteNo, panelNo: r.fromPanelNo } : null,
      to: { cassetteNo: r.toCassetteNo, panelNo: r.toPanelNo },
      reason: r.reason,
      requestedBy: r.requestedBy,
      requestedAt: r.requestedAt,
      decidedBy: r.decidedBy,
      decidedAt: r.decidedAt,
      decisionNote: r.decisionNote,
    })),
  };
}

/**
 * What is in one cassette, or on one panel of it.
 *
 * The question asked from the other direction: not "where is this
 * sample" but "what is supposed to be in cassette 4". Reads only
 * current placements, because a panel holds what is on it now.
 */
export async function contentsOf(cassetteNo: string, panelNo?: string) {
  const cassette = String(cassetteNo ?? '').trim();
  if (!cassette) throw AppError.badRequest('Which cassette?');
  const panel = String(panelNo ?? '').trim();

  const placements = await prisma.samplePlacement.findMany({
    where: {
      cassetteNo: cassette,
      ...(panel ? { panelNo: panel } : {}),
      isCurrent: true,
    },
    orderBy: { panelNo: 'asc' },
    include: {
      sample: {
        select: {
          id: true,
          sampleId: true,
          barcode: true,
          photoUrl: true,
          colour: {
            select: {
              colourName: true,
              product: { select: { id: true, name: true, productCode: true } },
            },
          },
        },
      },
    },
  });

  return {
    cassetteNo: cassette,
    panelNo: panel || null,
    samples: placements.map((p) => ({
      physicalSampleId: p.sample.id,
      sampleId: p.sample.sampleId,
      barcode: p.sample.barcode,
      photoUrl: p.sample.photoUrl,
      panelNo: p.panelNo,
      placedAt: p.placedAt,
      colourName: p.sample.colour.colourName,
      product: p.sample.colour.product,
    })),
  };
}
