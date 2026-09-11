import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { generateOpaqueToken } from '@utils/crypto';
import { logActivity } from './activityLog.service';
import { normalizeDriveImageUrl } from './referenceImages.service';
import {
  SaveMoodBoardInput,
  UpdateMoodBoardInput,
  ListMoodBoardsQuery,
  CombinationInput,
} from '@validators/moodBoard.validators';

/**
 * Confirms every tileId referenced in a set of combinations actually
 * exists in the Tile table. By the time staff calls Save, the
 * combinations should already be clean (Module 13's /generate already
 * dropped anything hallucinated) — if something invalid shows up here,
 * that means the client payload was tampered with or is stale, and
 * that's worth a loud, specific 400 rather than silently dropping data
 * a second time.
 */
async function assertTilesExist(combinations: CombinationInput[]): Promise<void> {
  const referencedIds = new Set<string>();
  combinations.forEach((c) => c.tiles.forEach((t) => referencedIds.add(t.tileId)));

  const existing = await prisma.tile.findMany({ where: { id: { in: [...referencedIds] } }, select: { id: true } });
  const existingIds = new Set(existing.map((t) => t.id));
  const missing = [...referencedIds].filter((id) => !existingIds.has(id));

  if (missing.length > 0) {
    throw AppError.badRequest('One or more combinations reference tiles that no longer exist', { missingTileIds: missing });
  }
}

function moodBoardTileRows(moodBoardId: string, combinations: CombinationInput[]) {
  return combinations.flatMap((combo, combinationIndex) =>
    combo.tiles.map((t) => ({
      moodBoardId,
      tileId: t.tileId,
      combinationIndex,
      role: t.role,
    })),
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Save Mood Board
// ─────────────────────────────────────────────────────────────────────────

export async function saveMoodBoard(input: SaveMoodBoardInput, actorId: string, req?: Request) {
  if (input.customerId) {
    const customer = await prisma.customer.findUnique({ where: { id: input.customerId } });
    if (!customer) throw AppError.notFound('Customer not found');
  }

  await assertTilesExist(input.combinations);

  const board = await prisma.moodBoard.create({
    data: {
      customerId: input.customerId,
      createdById: actorId,
      clientBrief: input.clientBrief,
      style: input.style,
      room: input.room,
      // See the identical cast + comment in errorLog.service.ts —
      // Prisma's Json input type is stricter than a concrete array type.
      combinations: input.combinations as unknown as object,
      status: 'GENERATED',
    },
    include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
  });

  const tileRows = moodBoardTileRows(board.id, input.combinations);
  if (tileRows.length > 0) {
    await prisma.moodBoardTile.createMany({ data: tileRows });
  }

  await logActivity({
    userId: actorId,
    action: 'mood_board.saved',
    entityType: 'MoodBoard',
    entityId: board.id,
    metadata: { combinationsCount: input.combinations.length, style: input.style, room: input.room },
    req,
  });

  return board;
}

// ─────────────────────────────────────────────────────────────────────────
// Resolve combination tile references
// ─────────────────────────────────────────────────────────────────────────

/**
 * /generate's response only carries {role, tileId, name} per tile -- no
 * image, size, finish or stock -- so the wizard's results/detail screens
 * can't render what was actually picked without this. Returns whatever
 * subset of the requested ids still exist (a tile can be deleted between
 * generating and viewing); callers should treat a missing id as "no
 * longer available" rather than an error.
 */
export async function getTilesByIds(ids: string[]) {
  const tiles = await prisma.tile.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      imageUrl: true,
      size: true,
      finish: true,
      colorTone: true,
      inStock: true,
      productCode: true,
      brand: { select: { id: true, name: true } },
    },
  });
  return tiles.map((t) => ({ ...t, imageUrl: normalizeDriveImageUrl(t.imageUrl) }));
}

// ─────────────────────────────────────────────────────────────────────────
// List / Get
// ─────────────────────────────────────────────────────────────────────────

export async function listMoodBoards(query: ListMoodBoardsQuery) {
  const { page, limit, skip, take } = getPagination(query);
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
    ...(query.search
      ? {
          OR: [
            { room: { contains: query.search, mode: 'insensitive' as const } },
            { style: { contains: query.search, mode: 'insensitive' as const } },
            { customer: { name: { contains: query.search, mode: 'insensitive' as const } } },
          ],
        }
      : {}),
  };

  const [boards, total] = await Promise.all([
    prisma.moodBoard.findMany({
      where,
      include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.moodBoard.count({ where }),
  ]);

  return { boards, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getMoodBoardById(id: string) {
  const board = await prisma.moodBoard.findUnique({
    where: { id },
    include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
  });
  if (!board) throw AppError.notFound('Mood board not found');
  return board;
}

// ─────────────────────────────────────────────────────────────────────────
// Update Mood Board
// ─────────────────────────────────────────────────────────────────────────

export async function updateMoodBoard(id: string, input: UpdateMoodBoardInput, actorId: string, req?: Request) {
  const existing = await prisma.moodBoard.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Mood board not found');

  const existingCombinations = existing.combinations as unknown as CombinationInput[];
  const effectiveCombinations = input.combinations ?? existingCombinations;

  if (input.selectedIndex !== undefined && input.selectedIndex >= effectiveCombinations.length) {
    throw AppError.badRequest(`selectedIndex ${input.selectedIndex} is out of range — this board has ${effectiveCombinations.length} combination(s)`);
  }

  if (input.combinations) {
    await assertTilesExist(input.combinations);
  }

  const updated = await prisma.$transaction(async (tx) => {
    if (input.combinations) {
      await tx.moodBoardTile.deleteMany({ where: { moodBoardId: id } });
      const tileRows = moodBoardTileRows(id, input.combinations);
      if (tileRows.length > 0) {
        await tx.moodBoardTile.createMany({ data: tileRows });
      }
    }

    return tx.moodBoard.update({
      where: { id },
      data: {
        ...(input.clientBrief !== undefined ? { clientBrief: input.clientBrief } : {}),
        ...(input.style !== undefined ? { style: input.style } : {}),
        ...(input.room !== undefined ? { room: input.room } : {}),
        ...(input.selectedIndex !== undefined ? { selectedIndex: input.selectedIndex } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.combinations !== undefined ? { combinations: input.combinations as unknown as object } : {}),
      },
      include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
    });
  });

  await logActivity({
    userId: actorId,
    action: 'mood_board.updated',
    entityType: 'MoodBoard',
    entityId: id,
    metadata: { changes: { ...input, combinations: input.combinations ? `${input.combinations.length} combination(s) replaced` : undefined } },
    req,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Delete Mood Board
// ─────────────────────────────────────────────────────────────────────────

export async function deleteMoodBoard(id: string, actorId: string, req?: Request) {
  const existing = await prisma.moodBoard.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Mood board not found');

  await prisma.moodBoard.delete({ where: { id } });

  await logActivity({
    userId: actorId,
    action: 'mood_board.deleted',
    entityType: 'MoodBoard',
    entityId: id,
    metadata: { clientBrief: existing.clientBrief, style: existing.style, room: existing.room },
    req,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Approve Mood Board
// ─────────────────────────────────────────────────────────────────────────

export async function approveMoodBoard(id: string, selectedIndex: number, actorId: string, req?: Request) {
  const existing = await prisma.moodBoard.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Mood board not found');

  const combinations = existing.combinations as unknown as CombinationInput[];
  if (selectedIndex >= combinations.length) {
    throw AppError.badRequest(`selectedIndex ${selectedIndex} is out of range — this board has ${combinations.length} combination(s)`);
  }

  const updated = await prisma.moodBoard.update({
    where: { id },
    data: { status: 'APPROVED', selectedIndex },
    include: { customer: { select: { id: true, name: true } }, createdBy: { select: { id: true, name: true } } },
  });

  await logActivity({
    userId: actorId,
    action: 'mood_board.approved',
    entityType: 'MoodBoard',
    entityId: id,
    metadata: { selectedIndex, boardName: combinations[selectedIndex]?.board_name },
    req,
  });

  return updated;
}

// ─────────────────────────────────────────────────────────────────────────
// Client Share/Approve
//
// A client opens the shared link with no login, so everything below this
// point deliberately does NOT go through `authenticate` (see
// moodBoard.routes.ts) and never returns more than the one combination
// actually being shared -- not the customer's phone/email, not the other
// combinations, not internal notes.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Idempotent: a board already shared returns its existing link instead of
 * minting a second one, so staff can click "Share with client" again later
 * just to re-copy the same URL without invalidating one already sent out.
 */
export async function shareMoodBoard(moodBoardId: string, actorId: string, req?: Request) {
  const board = await prisma.moodBoard.findUnique({ where: { id: moodBoardId } });
  if (!board) throw AppError.notFound('Mood board not found');

  const existing = await prisma.moodBoardShare.findUnique({ where: { moodBoardId } });
  if (existing) return existing;

  const share = await prisma.moodBoardShare.create({
    data: { moodBoardId, token: generateOpaqueToken(), createdById: actorId },
  });

  await logActivity({
    userId: actorId,
    action: 'mood_board.shared',
    entityType: 'MoodBoard',
    entityId: moodBoardId,
    req,
  });

  return share;
}

function selectedCombination(board: { combinations: unknown; selectedIndex: number | null }): CombinationInput | null {
  const combinations = board.combinations as unknown as CombinationInput[];
  const index = board.selectedIndex != null && combinations[board.selectedIndex] ? board.selectedIndex : 0;
  return combinations[index] ?? null;
}

/** Public, token-scoped view for the client's own shared-link page. */
export async function getSharedMoodBoardByToken(token: string) {
  const share = await prisma.moodBoardShare.findUnique({
    where: { token },
    include: {
      moodBoard: {
        include: { customer: { select: { name: true } }, createdBy: { select: { name: true } } },
      },
    },
  });
  if (!share) throw AppError.notFound('This share link is invalid or has expired');

  const board = share.moodBoard;
  const combination = selectedCombination(board);

  const tiles = combination ? await getTilesByIds([...new Set(combination.tiles.map((t) => t.tileId))]) : [];
  const tilesById = new Map(tiles.map((t) => [t.id, t]));

  return {
    clientName: board.customer?.name ?? null,
    designerName: board.createdBy?.name ?? null,
    room: board.room,
    style: board.style,
    status: board.status,
    clientResponse: share.clientResponse,
    combination: combination
      ? {
          boardName: combination.board_name,
          reasonForSelection: combination.reason_for_selection,
          groutRecommendation: combination.grout_recommendation,
          tiles: combination.tiles.map((t) => ({ role: t.role, ...(tilesById.get(t.tileId) ?? { id: t.tileId, name: t.name || 'Tile unavailable' }) })),
        }
      : null,
  };
}

/** Records the client's own response through the public link. */
export async function respondToSharedMoodBoard(token: string, response: 'APPROVED' | 'CHANGES_REQUESTED', req?: Request) {
  const share = await prisma.moodBoardShare.findUnique({ where: { token }, include: { moodBoard: true } });
  if (!share) throw AppError.notFound('This share link is invalid or has expired');

  await prisma.moodBoardShare.update({
    where: { id: share.id },
    data: { clientResponse: response, respondedAt: new Date() },
  });

  if (response === 'APPROVED') {
    const combinations = share.moodBoard.combinations as unknown as CombinationInput[];
    const index = share.moodBoard.selectedIndex != null && combinations[share.moodBoard.selectedIndex] ? share.moodBoard.selectedIndex : 0;
    await prisma.moodBoard.update({ where: { id: share.moodBoardId }, data: { status: 'APPROVED', selectedIndex: index } });
  }

  // No authenticated user on a public link -- logActivity's userId is
  // optional for exactly this case (an anonymous/system-triggered event).
  await logActivity({
    action: response === 'APPROVED' ? 'mood_board.client_approved' : 'mood_board.client_requested_changes',
    entityType: 'MoodBoard',
    entityId: share.moodBoardId,
    req,
  });

  return { clientResponse: response };
}