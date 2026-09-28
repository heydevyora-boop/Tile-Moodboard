"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createCustomer = createCustomer;
exports.listCustomers = listCustomers;
exports.getCustomerById = getCustomerById;
exports.updateCustomer = updateCustomer;
exports.deleteCustomer = deleteCustomer;
exports.getCustomerHistory = getCustomerHistory;
exports.listCustomerMoodBoards = listCustomerMoodBoards;
exports.listFavorites = listFavorites;
exports.addFavorite = addFavorite;
exports.removeFavorite = removeFavorite;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const pagination_1 = require("@utils/pagination");
const activityLog_service_1 = require("./activityLog.service");
async function createCustomer(input, actorId, req) {
    const customer = await connection_1.prisma.customer.create({
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
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'customer.created', entityType: 'Customer', entityId: customer.id, metadata: { name: customer.name }, req });
    return customer;
}
async function listCustomers(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = query.search
        ? {
            OR: [
                { name: { contains: query.search, mode: 'insensitive' } },
                { phone: { contains: query.search, mode: 'insensitive' } },
                { email: { contains: query.search, mode: 'insensitive' } },
            ],
        }
        : {};
    const [customers, total] = await Promise.all([
        connection_1.prisma.customer.findMany({ where, skip, take, orderBy: { createdAt: 'desc' } }),
        connection_1.prisma.customer.count({ where }),
    ]);
    return { customers, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getCustomerById(id) {
    const customer = await connection_1.prisma.customer.findUnique({ where: { id } });
    if (!customer)
        throw AppError_1.AppError.notFound('Customer not found');
    return customer;
}
async function updateCustomer(id, input, actorId, req) {
    const existing = await connection_1.prisma.customer.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Customer not found');
    const updated = await connection_1.prisma.customer.update({
        where: { id },
        data: {
            ...input,
            email: input.email === '' ? null : input.email,
        },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'customer.updated', entityType: 'Customer', entityId: id, metadata: { changes: input }, req });
    return updated;
}
async function deleteCustomer(id, actorId, req) {
    const existing = await connection_1.prisma.customer.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Customer not found');
    await connection_1.prisma.customer.delete({ where: { id } });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'customer.deleted', entityType: 'Customer', entityId: id, metadata: { name: existing.name }, req });
}
async function getCustomerHistory(customerId) {
    const customer = await connection_1.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer)
        throw AppError_1.AppError.notFound('Customer not found');
    const moodBoards = await connection_1.prisma.moodBoard.findMany({
        where: { customerId },
        include: { printBoards: true, createdBy: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
    });
    return moodBoards;
}
async function listCustomerMoodBoards(customerId, query) {
    const customer = await connection_1.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer)
        throw AppError_1.AppError.notFound('Customer not found');
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const [boards, total] = await Promise.all([
        connection_1.prisma.moodBoard.findMany({
            where: { customerId },
            include: { createdBy: { select: { id: true, name: true } } },
            skip,
            take,
            orderBy: { createdAt: 'desc' },
        }),
        connection_1.prisma.moodBoard.count({ where: { customerId } }),
    ]);
    return { boards, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function listFavorites(customerId) {
    const customer = await connection_1.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer)
        throw AppError_1.AppError.notFound('Customer not found');
    return connection_1.prisma.customerFavorite.findMany({
        where: { customerId },
        include: { tile: { include: { brand: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
    });
}
async function addFavorite(customerId, tileId, note, actorId, req) {
    const [customer, tile] = await Promise.all([
        connection_1.prisma.customer.findUnique({ where: { id: customerId } }),
        connection_1.prisma.tile.findUnique({ where: { id: tileId } }),
    ]);
    if (!customer)
        throw AppError_1.AppError.notFound('Customer not found');
    if (!tile)
        throw AppError_1.AppError.notFound('Tile not found');
    const existing = await connection_1.prisma.customerFavorite.findFirst({ where: { customerId, tileId } });
    if (existing)
        throw AppError_1.AppError.conflict('This tile is already favorited for this customer');
    const favorite = await connection_1.prisma.customerFavorite.create({
        data: { customerId, tileId, note, createdById: actorId },
        include: { tile: { include: { brand: { select: { name: true } } } } },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'customer.favorite_added', entityType: 'Customer', entityId: customerId, metadata: { tileId, tileName: tile.name }, req });
    return favorite;
}
async function removeFavorite(customerId, tileId, actorId, req) {
    const existing = await connection_1.prisma.customerFavorite.findFirst({ where: { customerId, tileId } });
    if (!existing)
        throw AppError_1.AppError.notFound('Favorite not found');
    await connection_1.prisma.customerFavorite.delete({ where: { id: existing.id } });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'customer.favorite_removed', entityType: 'Customer', entityId: customerId, metadata: { tileId }, req });
}
//# sourceMappingURL=customer.service.js.map