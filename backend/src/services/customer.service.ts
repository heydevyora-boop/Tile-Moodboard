import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { logActivity } from './activityLog.service';
import { CreateCustomerInput, UpdateCustomerInput, ListCustomersQuery } from '@validators/customer.validators';

export async function createCustomer(input: CreateCustomerInput, actorId: string, req?: Request) {
  const customer = await prisma.customer.create({
    data: {
      name: input.name,
      phone: input.phone || undefined,
      email: input.email || undefined,
      preferredStyle: input.preferredStyle,
      preferredRoom: input.preferredRoom,
      budget: input.budget,
      notes: input.notes,
      createdById: actorId,
    },
  });

  await logActivity({ userId: actorId, action: 'customer.created', entityType: 'Customer', entityId: customer.id, metadata: { name: customer.name }, req });

  return customer;
}

export async function listCustomers(query: ListCustomersQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const where = query.search
    ? {
        OR: [
          { name: { contains: query.search, mode: 'insensitive' as const } },
          { phone: { contains: query.search, mode: 'insensitive' as const } },
          { email: { contains: query.search, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const [customers, total] = await Promise.all([
    prisma.customer.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
    prisma.customer.count({ where }),
  ]);

  return { customers, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getCustomerById(id: string) {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) throw AppError.notFound('Customer not found');
  return customer;
}

export async function updateCustomer(id: string, input: UpdateCustomerInput, actorId: string, req?: Request) {
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Customer not found');

  const updated = await prisma.customer.update({
    where: { id },
    data: {
      ...input,
      email: input.email === '' ? null : input.email,
    },
  });

  await logActivity({ userId: actorId, action: 'customer.updated', entityType: 'Customer', entityId: id, metadata: { changes: input }, req });

  return updated;
}

export async function deleteCustomer(id: string, actorId: string, req?: Request) {
  const existing = await prisma.customer.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Customer not found');

  await prisma.customer.delete({ where: { id } });

  await logActivity({ userId: actorId, action: 'customer.deleted', entityType: 'Customer', entityId: id, metadata: { name: existing.name }, req });
}

export async function getCustomerHistory(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw AppError.notFound('Customer not found');

  const moodBoards = await prisma.moodBoard.findMany({
    where: { customerId },
    include: { printBoards: true, createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return moodBoards;
}

export async function listCustomerMoodBoards(customerId: string, query: { page: number; limit: number }) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw AppError.notFound('Customer not found');

  const { page, limit, skip, take } = getPagination(query);
  const [boards, total] = await Promise.all([
    prisma.moodBoard.findMany({
      where: { customerId },
      include: { createdBy: { select: { id: true, name: true } } },
      skip,
      take,
      orderBy: { createdAt: 'desc' },
    }),
    prisma.moodBoard.count({ where: { customerId } }),
  ]);

  return { boards, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function listFavorites(customerId: string) {
  const customer = await prisma.customer.findUnique({ where: { id: customerId } });
  if (!customer) throw AppError.notFound('Customer not found');

  return prisma.customerFavorite.findMany({
    where: { customerId },
    include: { tile: { include: { brand: { select: { name: true } } } } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function addFavorite(customerId: string, tileId: string, note: string | undefined, actorId: string, req?: Request) {
  const [customer, tile] = await Promise.all([
    prisma.customer.findUnique({ where: { id: customerId } }),
    prisma.tile.findUnique({ where: { id: tileId } }),
  ]);
  if (!customer) throw AppError.notFound('Customer not found');
  if (!tile) throw AppError.notFound('Tile not found');

  const existing = await prisma.customerFavorite.findFirst({ where: { customerId, tileId } });
  if (existing) throw AppError.conflict('This tile is already favorited for this customer');

  const favorite = await prisma.customerFavorite.create({
    data: { customerId, tileId, note, createdById: actorId },
    include: { tile: { include: { brand: { select: { name: true } } } } },
  });

  await logActivity({ userId: actorId, action: 'customer.favorite_added', entityType: 'Customer', entityId: customerId, metadata: { tileId, tileName: tile.name }, req });

  return favorite;
}

export async function removeFavorite(customerId: string, tileId: string, actorId: string, req?: Request) {
  const existing = await prisma.customerFavorite.findFirst({ where: { customerId, tileId } });
  if (!existing) throw AppError.notFound('Favorite not found');

  await prisma.customerFavorite.delete({ where: { id: existing.id } });

  await logActivity({ userId: actorId, action: 'customer.favorite_removed', entityType: 'Customer', entityId: customerId, metadata: { tileId }, req });
}
