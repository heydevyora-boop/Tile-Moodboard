"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listUsers = listUsers;
exports.getUserById = getUserById;
exports.createUser = createUser;
exports.updateUser = updateUser;
exports.deleteUser = deleteUser;
exports.assignRole = assignRole;
exports.getProfile = getProfile;
exports.updateProfile = updateProfile;
exports.changeOwnPassword = changeOwnPassword;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const password_1 = require("@utils/password");
const pagination_1 = require("@utils/pagination");
const token_service_1 = require("./token.service");
const activityLog_service_1 = require("./activityLog.service");
function toSafeUser(user) {
    return {
        id: user.id,
        name: user.name,
        email: user.email,
        isActive: user.isActive,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        role: user.role,
    };
}
async function assertNotLastOwner(user, excludingUserId) {
    if (user.role.name !== 'OWNER')
        return;
    const otherActiveOwners = await connection_1.prisma.user.count({
        where: {
            role: { name: 'OWNER' },
            isActive: true,
            NOT: { id: excludingUserId ?? user.id },
        },
    });
    if (otherActiveOwners === 0) {
        throw AppError_1.AppError.badRequest('Cannot remove the last active Owner account. Promote another user to Owner first.');
    }
}
async function listUsers(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const where = {
        ...(query.roleId ? { roleId: query.roleId } : {}),
        ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
        ...(query.search
            ? {
                OR: [
                    { name: { contains: query.search, mode: 'insensitive' } },
                    { email: { contains: query.search, mode: 'insensitive' } },
                ],
            }
            : {}),
    };
    const [records, total] = await Promise.all([
        connection_1.prisma.user.findMany({ where, include: { role: true }, skip, take, orderBy: { createdAt: 'desc' } }),
        connection_1.prisma.user.count({ where }),
    ]);
    return {
        users: records.map(toSafeUser),
        meta: (0, pagination_1.buildPaginationMeta)(total, page, limit),
    };
}
async function getUserById(id) {
    const user = (await connection_1.prisma.user.findUnique({ where: { id }, include: { role: true } }));
    if (!user)
        throw AppError_1.AppError.notFound('User not found');
    return toSafeUser(user);
}
async function createUser(input, actorId, req) {
    const role = await connection_1.prisma.role.findUnique({ where: { id: input.roleId } });
    if (!role)
        throw AppError_1.AppError.badRequest('Selected role does not exist');
    const passwordHash = await (0, password_1.hashPassword)(input.password);
    const user = (await connection_1.prisma.user.create({
        data: {
            name: input.name,
            email: input.email,
            passwordHash,
            roleId: input.roleId,
            isActive: input.isActive,
        },
        include: { role: true },
    }));
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'user.created',
        entityType: 'User',
        entityId: user.id,
        metadata: { name: user.name, email: user.email, role: user.role.name },
        req,
    });
    return toSafeUser(user);
}
async function updateUser(id, input, actorId, req) {
    const existing = (await connection_1.prisma.user.findUnique({ where: { id }, include: { role: true } }));
    if (!existing)
        throw AppError_1.AppError.notFound('User not found');
    const isDeactivating = input.isActive === false && existing.isActive === true;
    if (isDeactivating) {
        await assertNotLastOwner(existing);
    }
    const updated = (await connection_1.prisma.user.update({
        where: { id },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
            ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
        include: { role: true },
    }));
    if (isDeactivating) {
        await (0, token_service_1.revokeAllUserTokens)(id);
    }
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'user.updated',
        entityType: 'User',
        entityId: id,
        metadata: { changes: input },
        req,
    });
    return toSafeUser(updated);
}
async function deleteUser(id, actorId, req) {
    if (id === actorId) {
        throw AppError_1.AppError.badRequest('You cannot delete your own account');
    }
    const existing = (await connection_1.prisma.user.findUnique({ where: { id }, include: { role: true } }));
    if (!existing)
        throw AppError_1.AppError.notFound('User not found');
    await assertNotLastOwner(existing);
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'user.deleted',
        entityType: 'User',
        entityId: id,
        metadata: { name: existing.name, email: existing.email, role: existing.role.name },
        req,
    });
    await connection_1.prisma.user.delete({ where: { id } });
}
async function assignRole(id, roleId, actorId, req) {
    const [existing, newRole] = await Promise.all([
        connection_1.prisma.user.findUnique({ where: { id }, include: { role: true } }),
        connection_1.prisma.role.findUnique({ where: { id: roleId } }),
    ]);
    if (!existing)
        throw AppError_1.AppError.notFound('User not found');
    if (!newRole)
        throw AppError_1.AppError.badRequest('Selected role does not exist');
    if (existing.roleId === roleId) {
        return toSafeUser(existing);
    }
    if (existing.role.name === 'OWNER' && newRole.name !== 'OWNER') {
        await assertNotLastOwner(existing);
    }
    const updated = (await connection_1.prisma.user.update({ where: { id }, data: { roleId }, include: { role: true } }));
    await (0, token_service_1.revokeAllUserTokens)(id);
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'user.role_assigned',
        entityType: 'User',
        entityId: id,
        metadata: { fromRole: existing.role.name, toRole: newRole.name },
        req,
    });
    return toSafeUser(updated);
}
async function getProfile(userId) {
    return getUserById(userId);
}
async function updateProfile(userId, input, req) {
    const updated = (await connection_1.prisma.user.update({
        where: { id: userId },
        data: {
            ...(input.name !== undefined ? { name: input.name } : {}),
            ...(input.email !== undefined ? { email: input.email } : {}),
        },
        include: { role: true },
    }));
    await (0, activityLog_service_1.logActivity)({ userId, action: 'user.profile_updated', entityType: 'User', entityId: userId, metadata: { changes: input }, req });
    return toSafeUser(updated);
}
async function changeOwnPassword(userId, input, req) {
    const user = await connection_1.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
        throw AppError_1.AppError.notFound('User not found');
    const currentPasswordOk = await (0, password_1.comparePassword)(input.currentPassword, user.passwordHash);
    if (!currentPasswordOk) {
        throw AppError_1.AppError.badRequest('Current password is incorrect');
    }
    const passwordHash = await (0, password_1.hashPassword)(input.newPassword);
    await connection_1.prisma.user.update({ where: { id: userId }, data: { passwordHash } });
    await (0, token_service_1.revokeAllUserTokens)(userId);
    await (0, activityLog_service_1.logActivity)({ userId, action: 'user.password_changed', entityType: 'User', entityId: userId, req });
}
//# sourceMappingURL=user.service.js.map