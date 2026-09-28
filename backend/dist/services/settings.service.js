"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.getAllSettings = getAllSettings;
exports.updateSettings = updateSettings;
const connection_1 = require("@db/connection");
const activityLog_service_1 = require("./activityLog.service");
const settings_validators_1 = require("@validators/settings.validators");
function defaultsFor(category) {
    return settings_validators_1.settingsSchemasByCategory[category].parse({});
}
async function getSettings(category) {
    const row = await connection_1.prisma.setting.findUnique({ where: { key: category } });
    const defaults = defaultsFor(category);
    if (!row)
        return defaults;
    return { ...defaults, ...row.value };
}
async function getAllSettings() {
    const categories = Object.keys(settings_validators_1.settingsSchemasByCategory);
    const entries = await Promise.all(categories.map(async (c) => [c, await getSettings(c)]));
    return Object.fromEntries(entries);
}
async function updateSettings(category, value, actorId, req) {
    const row = await connection_1.prisma.setting.upsert({
        where: { key: category },
        create: { key: category, category, value: value, updatedById: actorId },
        update: { value: value, updatedById: actorId },
    });
    await (0, activityLog_service_1.logActivity)({ userId: actorId, action: 'settings.updated', entityType: 'Setting', entityId: row.id, metadata: { category }, req });
    return value;
}
//# sourceMappingURL=settings.service.js.map