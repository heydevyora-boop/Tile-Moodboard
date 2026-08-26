import { Request } from 'express';
import { prisma } from '@db/connection';
import { AppError } from '@utils/AppError';
import { getPagination, buildPaginationMeta, PaginationMeta } from '@utils/pagination';
import { diffLines, DiffLine } from '@utils/diffLines';
import { logActivity } from './activityLog.service';
import { CreateDesignRuleInput, UpdateDesignRuleInput, ListVersionsQuery } from '@validators/designRules.validators';

const SECTION_ORDER = ['GENERAL', 'STYLE', 'ROOM', 'CLIENT'] as const;

interface CompilableRule {
  section: 'GENERAL' | 'STYLE' | 'ROOM' | 'CLIENT';
  key: string | null;
  title: string;
  content: string;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Builds the same compiled document text used for both the live preview
 * and the published RuleVersion snapshot — one function, so "what you
 * previewed" and "what got published" can never drift apart. Matches the
 * shape of the original design_rules.txt from the build guide.
 */
export function compileRulesText(rules: CompilableRule[]): string {
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

// ─────────────────────────────────────────────────────────────────────────
// Draft rules — Create / Edit / list
// ─────────────────────────────────────────────────────────────────────────

export async function listDesignRules() {
  return prisma.designRule.findMany({ orderBy: [{ section: 'asc' }, { sortOrder: 'asc' }] });
}

export async function getDesignRule(id: string) {
  const rule = await prisma.designRule.findUnique({ where: { id } });
  if (!rule) throw AppError.notFound('Design rule not found');
  return rule;
}

export async function createDesignRule(input: CreateDesignRuleInput, actorId: string, req?: Request) {
  const rule = await prisma.designRule.create({
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

  await logActivity({
    userId: actorId,
    action: 'design_rules.rule_created',
    entityType: 'DesignRule',
    entityId: rule.id,
    metadata: { section: rule.section, key: rule.key, title: rule.title },
    req,
  });

  return rule;
}

export async function updateDesignRule(id: string, input: UpdateDesignRuleInput, actorId: string, req?: Request) {
  const existing = await prisma.designRule.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Design rule not found');

  const updated = await prisma.designRule.update({
    where: { id },
    data: { ...input, updatedById: actorId },
  });

  await logActivity({
    userId: actorId,
    action: 'design_rules.rule_updated',
    entityType: 'DesignRule',
    entityId: id,
    metadata: { changes: input },
    req,
  });

  return updated;
}

export async function deleteDesignRule(id: string, actorId: string, req?: Request) {
  const existing = await prisma.designRule.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('Design rule not found');

  await prisma.designRule.delete({ where: { id } });

  await logActivity({
    userId: actorId,
    action: 'design_rules.rule_deleted',
    entityType: 'DesignRule',
    entityId: id,
    metadata: { section: existing.section, key: existing.key, title: existing.title },
    req,
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Live preview & publish
// ─────────────────────────────────────────────────────────────────────────

export interface PreviewResult {
  content: string;
  activeRuleCount: number;
  lastPublished: { versionNumber: number; createdAt: Date } | null;
  hasUnpublishedChanges: boolean;
}

export async function previewDraft(): Promise<PreviewResult> {
  const [rules, latestVersion] = await Promise.all([
    listDesignRules(),
    prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } }),
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

export async function publishRules(changeSummary: string | undefined, actorId: string, req?: Request) {
  const rules = await listDesignRules();
  const content = compileRulesText(rules);

  const latest = await prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
  const nextVersionNumber = (latest?.versionNumber ?? 0) + 1;

  if (latest && latest.fullContent === content) {
    throw AppError.badRequest('No changes since the last published version — nothing to publish');
  }

  const rulesSnapshot: CompilableRule[] = rules.map((r) => ({
    section: r.section,
    key: r.key,
    title: r.title,
    content: r.content,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
  }));

  const version = await prisma.ruleVersion.create({
    data: {
      versionNumber: nextVersionNumber,
      fullContent: content,
      // See the identical cast + comment in errorLog.service.ts —
      // Prisma's Json input type is stricter than a concrete array type.
      rulesSnapshot: rulesSnapshot as unknown as object,
      changeSummary: changeSummary ?? null,
      createdById: actorId,
    },
  });

  await logActivity({
    userId: actorId,
    action: 'design_rules.published',
    entityType: 'RuleVersion',
    entityId: version.id,
    metadata: { versionNumber: version.versionNumber, changeSummary },
    req,
  });

  return version;
}

export async function getLiveVersion() {
  const latest = await prisma.ruleVersion.findFirst({ orderBy: { versionNumber: 'desc' } });
  if (!latest) throw AppError.notFound('No design rules have been published yet');
  return latest;
}

export async function listVersionHistory(query: ListVersionsQuery) {
  const { page, limit, skip, take } = getPagination(query);

  const [versions, total] = await Promise.all([
    prisma.ruleVersion.findMany({
      orderBy: { versionNumber: 'desc' },
      skip,
      take,
      include: { createdBy: { select: { id: true, name: true } } },
    }),
    prisma.ruleVersion.count(),
  ]);

  return { versions, meta: buildPaginationMeta(total, page, limit) as PaginationMeta };
}

export async function getVersionById(id: string) {
  const version = await prisma.ruleVersion.findUnique({ where: { id }, include: { createdBy: { select: { id: true, name: true } } } });
  if (!version) throw AppError.notFound('Version not found');
  return version;
}

export interface CompareResult {
  from: { id: string; versionNumber: number };
  to: { id: string; versionNumber: number };
  diff: DiffLine[];
}

export async function compareVersions(fromId: string, toId: string): Promise<CompareResult> {
  const [from, to] = await Promise.all([
    prisma.ruleVersion.findUnique({ where: { id: fromId } }),
    prisma.ruleVersion.findUnique({ where: { id: toId } }),
  ]);
  if (!from) throw AppError.notFound(`Version not found: ${fromId}`);
  if (!to) throw AppError.notFound(`Version not found: ${toId}`);

  return {
    from: { id: from.id, versionNumber: from.versionNumber },
    to: { id: to.id, versionNumber: to.versionNumber },
    diff: diffLines(from.fullContent, to.fullContent),
  };
}

/**
 * Restores a past version's structured rules back into the DRAFT table
 * (DesignRule) — it does NOT automatically publish. This is deliberate:
 * restoring shouldn't silently change what the AI is currently using
 * without an explicit publish, the same way editing a draft rule doesn't.
 * The admin restores, reviews the draft/preview, then publishes if it
 * looks right.
 *
 * Every current draft rule is replaced wholesale (deleted, then
 * recreated from the snapshot) rather than diffed/merged — restore means
 * "go back to exactly this," not "merge forward from this."
 */
export async function restoreVersion(versionId: string, actorId: string, req?: Request) {
  const version = await prisma.ruleVersion.findUnique({ where: { id: versionId } });
  if (!version) throw AppError.notFound('Version not found');

  const snapshot = version.rulesSnapshot as unknown as CompilableRule[];
  if (!Array.isArray(snapshot)) {
    throw AppError.badRequest('This version has no restorable snapshot (published before restore support was added)');
  }

  await prisma.$transaction([
    prisma.designRule.deleteMany({}),
    ...(snapshot.length > 0
      ? [
          prisma.designRule.createMany({
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

  await logActivity({
    userId: actorId,
    action: 'design_rules.version_restored',
    entityType: 'RuleVersion',
    entityId: versionId,
    metadata: { versionNumber: version.versionNumber, ruleCount: snapshot.length },
    req,
  });

  return listDesignRules();
}

export async function deleteVersion(versionId: string, actorId: string, req?: Request) {
  const version = await prisma.ruleVersion.findUnique({ where: { id: versionId } });
  if (!version) throw AppError.notFound('Version not found');

  await prisma.ruleVersion.delete({ where: { id: versionId } });

  await logActivity({
    userId: actorId,
    action: 'design_rules.version_deleted',
    entityType: 'RuleVersion',
    entityId: versionId,
    metadata: { versionNumber: version.versionNumber },
    req,
  });
}