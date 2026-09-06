"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.listRoles = listRoles;
exports.updateRole = updateRole;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const activityLog_service_1 = require("./activityLog.service");
async function listRoles() {
    const roles = await connection_1.prisma.role.findMany({ orderBy: { name: 'asc' } });
    return roles;
}
async function updateRole(id, input, actorId, req) {
    const existing = await connection_1.prisma.role.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Role not found');
    if (existing.name === 'OWNER') {
        throw AppError_1.AppError.badRequest('The Owner role always has full access and cannot be edited.');
    }
    const role = await connection_1.prisma.role.update({
        where: { id },
        data: {
            ...(input.description !== undefined ? { description: input.description } : {}),
            ...(input.permissions !== undefined ? { permissions: input.permissions } : {}),
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'role.updated',
        entityType: 'Role',
        entityId: id,
        metadata: { name: existing.name, permissions: input.permissions },
        req,
    });
    return role;
}
//# sourceMappingURL=role.service.js.map