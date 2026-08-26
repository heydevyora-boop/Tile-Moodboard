import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { logActivity } from './activityLog.service';
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
// List / Get
// ─────────────────────────────────────────────────────────────────────────

export async function listMoodBoards(query: ListMoodBoardsQuery) {
  const { page, limit, skip, take } = getPagination(query);
  const where = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.customerId ? { customerId: query.customerId } : {}),
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