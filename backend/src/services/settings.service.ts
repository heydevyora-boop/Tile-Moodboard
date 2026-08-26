import { Request } from 'express';
import { prisma } from '@db/connection';
import { logActivity } from './activityLog.service';
import { settingsSchemasByCategory, SettingsCategory } from '@validators/settings.validators';

type SettingsFor<C extends SettingsCategory> = ReturnType<(typeof settingsSchemasByCategory)[C]['parse']>;

function defaultsFor<C extends SettingsCategory>(category: C): SettingsFor<C> {
  return settingsSchemasByCategory[category].parse({}) as SettingsFor<C>;
}

export async function getSettings<C extends SettingsCategory>(category: C): Promise<SettingsFor<C>> {
  const row = await prisma.setting.findUnique({ where: { key: category } });
  const defaults = defaultsFor(category);
  if (!row) return defaults;
  return { ...defaults, ...(row.value as object) } as SettingsFor<C>;
}

export async function getAllSettings() {
  const categories = Object.keys(settingsSchemasByCategory) as SettingsCategory[];
  const entries = await Promise.all(categories.map(async (c) => [c, await getSettings(c)] as const));
  return Object.fromEntries(entries);
}

export async function updateSettings<C extends SettingsCategory>(category: C, value: Record<string, unknown>, actorId: string, req?: Request) {
  const row = await prisma.setting.upsert({
    where: { key: category },
    create: { key: category, category, value: value as unknown as object, updatedById: actorId },
    update: { value: value as unknown as object, updatedById: actorId },
  });

  await logActivity({ userId: actorId, action: 'settings.updated', entityType: 'Setting', entityId: row.id, metadata: { category }, req });

  return value;
}