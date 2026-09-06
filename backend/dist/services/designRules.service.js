"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.compileRulesText = compileRulesText;
exports.listDesignRules = listDesignRules;
exports.getDesignRule = getDesignRule;
exports.createDesignRule = createDesignRule;
exports.updateDesignRule = updateDesignRule;
exports.deleteDesignRule = deleteDesignRule;
exports.previewDraft = previewDraft;
exports.publishRules = publishRules;
exports.getLiveVersion = getLiveVersion;
exports.listVersionHistory = listVersionHistory;
exports.getVersionById = getVersionById;
exports.compareVersions = compareVersions;
exports.restoreVersion = restoreVersion;
exports.deleteVersion = deleteVersion;
const connection_1 = require("@db/connection");
const AppError_1 = require("@utils/AppError");
const pagination_1 = require("@utils/pagination");
const diffLines_1 = require("@utils/diffLines");
const activityLog_service_1 = require("./activityLog.service");
const SECTION_ORDER = ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'];
function compileRulesText(rules) {
    const active = rules.filter((r) => r.isActive);
    const bySection = SECTION_ORDER.map((section) => ({
        section,
        rules: active.filter((r) => r.section === section).sort((a, b) => a.sortOrder - b.sortOrder),
    })).filter((group) => group.rules.length > 0);
    const lines = [
        '# CASA DE AURUM — INTERNAL DESIGN RULES',
        '# Written by store owner. Loaded into AI system prompt automatically.',
        '# Edit this file any time to update how mood boards are generated.',
        '',
    ];
    for (const group of bySection) {
        for (const rule of group.rules) {
            lines.push(`## ${rule.title.toUpperCase()}`, rule.content, '');
        }
    }
    return lines.join('\n').trimEnd() + '\n';
}
async function listDesignRules() {
    return connection_1.prisma.designRule.findMany({ orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] });
}
async function getDesignRule(id) {
    const rule = await connection_1.prisma.designRule.findUnique({ where: { id } });
    if (!rule)
        throw AppError_1.AppError.notFound('Design rule not found');
    return rule;
}
async function createDesignRule(input, actorId, req) {
    const rule = await connection_1.prisma.designRule.create({
        data: {
            section: input.section,
            key: input.key ?? null,
            title: input.title,
            content: input.content,
            sortOrder: input.sortOrder,
            isActive: input.isActive,
            updatedById: actorId,
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.rule_created',
        entityType: 'DesignRule',
        entityId: rule.id,
        metadata: { section: rule.section, key: rule.key, title: rule.title },
        req,
    });
    return rule;
}
async function updateDesignRule(id, input, actorId, req) {
    const existing = await connection_1.prisma.designRule.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Design rule not found');
    const updated = await connection_1.prisma.designRule.update({
        where: { id },
        data: { ...input, updatedById: actorId },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.rule_updated',
        entityType: 'DesignRule',
        entityId: id,
        metadata: { changes: input },
        req,
    });
    return updated;
}
async function deleteDesignRule(id, actorId, req) {
    const existing = await connection_1.prisma.designRule.findUnique({ where: { id } });
    if (!existing)
        throw AppError_1.AppError.notFound('Design rule not found');
    await connection_1.prisma.designRule.delete({ where: { id } });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.rule_deleted',
        entityType: 'DesignRule',
        entityId: id,
        metadata: { section: existing.section, key: existing.key, title: existing.title },
        req,
    });
}
async function previewDraft() {
    const [rules, latestVersion] = await Promise.all([
        listDesignRules(),
        connection_1.prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } }),
    ]);
    const content = compileRulesText(rules);
    const hasUnpublishedChanges = latestVersion ? content !== latestVersion.fullContent : rules.some((r) => r.isActive);
    return {
        content,
        activeRuleCount: rules.filter((r) => r.isActive).length,
        lastPublished: latestVersion ? { versionNumber: latestVersion.versionNumber, createdAt: latestVersion.createdAt } : null,
        hasUnpublishedChanges,
    };
}
async function publishRules(changeSummary, actorId, req) {
    const rules = await listDesignRules();
    const content = compileRulesText(rules);
    const latest = await connection_1.prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
    const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;
    if (latest && latest.fullContent === content) {
        throw AppError_1.AppError.badRequest('No changes since the last published version — nothing to publish');
    }
    const rulesSnapshot = rules.map((r) => ({
        section: r.section,
        key: r.key,
        title: r.title,
        content: r.content,
        sortOrder: r.sortOrder,
        isActive: r.isActive,
    }));
    const version = await connection_1.prisma.ruleVersion.create({
        data: {
            versionNumber: nextVersionNumber,
            fullContent: content,
            rulesSnapshot: rulesSnapshot,
            changeSummary: changeSummary ?? null,
            createdById: actorId,
        },
    });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.published',
        entityType: 'RuleVersion',
        entityId: version.id,
        metadata: { versionNumber: version.versionNumber, changeSummary },
        req,
    });
    return version;
}
async function getLiveVersion() {
    const latest = await connection_1.prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
    if (!latest)
        throw AppError_1.AppError.notFound('No design rules have been published yet');
    return latest;
}
async function listVersionHistory(query) {
    const { page, limit, skip, take } = (0, pagination_1.getPagination)(query);
    const [versions, total] = await Promise.all([
        connection_1.prisma.ruleVersion.findMany({
            orderBy: { versionNumber: 'desc' },
            skip,
            take,
            include: { createdBy: { select: { id: true, name: true } } },
        }),
        connection_1.prisma.ruleVersion.count(),
    ]);
    return { versions, meta: (0, pagination_1.buildPaginationMeta)(total, page, limit) };
}
async function getVersionById(id) {
    const version = await connection_1.prisma.ruleVersion.findUnique({ where: { id }, include: { createdBy: { select: { id: true, name: true } } } });
    if (!version)
        throw AppError_1.AppError.notFound('Version not found');
    return version;
}
async function compareVersions(fromId, toId) {
    const [from, to] = await Promise.all([
        connection_1.prisma.ruleVersion.findUnique({ where: { id: fromId } }),
        connection_1.prisma.ruleVersion.findUnique({ where: { id: toId } }),
    ]);
    if (!from)
        throw AppError_1.AppError.notFound(`Version not found: ${fromId}`);
    if (!to)
        throw AppError_1.AppError.notFound(`Version not found: ${toId}`);
    return {
        from: { id: from.id, versionNumber: from.versionNumber },
        to: { id: to.id, versionNumber: to.versionNumber },
        diff: (0, diffLines_1.diffLines)(from.fullContent, to.fullContent),
    };
}
async function restoreVersion(versionId, actorId, req) {
    const version = await connection_1.prisma.ruleVersion.findUnique({ where: { id: versionId } });
    if (!version)
        throw AppError_1.AppError.notFound('Version not found');
    const snapshot = version.rulesSnapshot;
    if (!Array.isArray(snapshot)) {
        throw AppError_1.AppError.badRequest('This version has no restorable snapshot (published before restore support was added)');
    }
    await connection_1.prisma.$transaction([
        connection_1.prisma.designRule.deleteMany({}),
        ...(snapshot.length > 0
            ? [
                connection_1.prisma.designRule.createMany({
                    data: snapshot.map((r) => ({
                        section: r.section,
                        key: r.key,
                        title: r.title,
                        content: r.content,
                        sortOrder: r.sortOrder,
                        isActive: r.isActive,
                        updatedById: actorId,
                    })),
                }),
            ]
            : []),
    ]);
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.version_restored',
        entityType: 'RuleVersion',
        entityId: versionId,
        metadata: { versionNumber: version.versionNumber, ruleCount: snapshot.length },
        req,
    });
    return listDesignRules();
}
async function deleteVersion(versionId, actorId, req) {
    const version = await connection_1.prisma.ruleVersion.findUnique({ where: { id: versionId } });
    if (!version)
        throw AppError_1.AppError.notFound('Version not found');
    await connection_1.prisma.ruleVersion.delete({ where: { id: versionId } });
    await (0, activityLog_service_1.logActivity)({
        userId: actorId,
        action: 'design_rules.version_deleted',
        entityType: 'RuleVersion',
        entityId: versionId,
        metadata: { versionNumber: version.versionNumber },
        req,
    });
}
//# sourceMappingURL=designRules.service.js.map