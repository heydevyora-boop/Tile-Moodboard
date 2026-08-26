import { Request } from 'express';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { encryptSecret, decryptSecret, deriveEncryptionKey } from '@utils/crypto';
import { logActivity } from './activityLog.service';
import { CreateApiKeyInput, RotateApiKeyInput, ListApiKeysQuery } from '@validators/apiKey.validators';

const encryptionKey = deriveEncryptionKey(config.auth.encryptionKey);

/** Never return the real value — just enough to recognize which key it is (e.g. "AIza...9fX2"). */
function maskValue(plaintext: string): string {
  if (plaintext.length <= 8) return '****';
  return `${plaintext.slice(0, 4)}...${plaintext.slice(-4)}`;
}

interface ApiKeyRow {
  id: string;
  service: string;
  label: string;
  encryptedValue: string;
  isActive: boolean;
  lastRotatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy?: { id: string; name: string } | null;
}

function toPublicShape(row: ApiKeyRow) {
  let masked = '(unreadable)';
  try {
    masked = maskValue(decryptSecret(row.encryptedValue, encryptionKey));
  } catch {
    // If decryption ever fails (e.g. ENCRYPTION_KEY changed since this was stored), surface that
    // honestly rather than crashing the whole list — the key is unusable until re-rotated either way.
  }
  return {
    id: row.id,
    service: row.service,
    label: row.label,
    maskedValue: masked,
    isActive: row.isActive,
    lastRotatedAt: row.lastRotatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    createdBy: row.createdBy ?? null,
  };
}

export async function listApiKeys(query: ListApiKeysQuery) {
  const rows = await prisma.apiKey.findMany({
    where: query.service ? { service: query.service } : {},
    include: { createdBy: { select: { id: true, name: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toPublicShape);
}

export async function createApiKey(input: CreateApiKeyInput, actorId: string, req?: Request) {
  const encryptedValue = encryptSecret(input.value, encryptionKey);

  const row = await prisma.apiKey.create({
    data: { service: input.service, label: input.label, encryptedValue, createdById: actorId, lastRotatedAt: new Date() },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  await logActivity({ userId: actorId, action: 'api_key.created', entityType: 'ApiKey', entityId: row.id, metadata: { service: input.service, label: input.label }, req });

  return toPublicShape(row);
}

export async function rotateApiKey(id: string, input: RotateApiKeyInput, actorId: string, req?: Request) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('API key not found');

  const encryptedValue = encryptSecret(input.value, encryptionKey);
  const row = await prisma.apiKey.update({
    where: { id },
    data: { encryptedValue, lastRotatedAt: new Date() },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  await logActivity({ userId: actorId, action: 'api_key.rotated', entityType: 'ApiKey', entityId: id, metadata: { service: existing.service, label: existing.label }, req });

  return toPublicShape(row);
}

export async function setApiKeyActive(id: string, isActive: boolean, actorId: string, req?: Request) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('API key not found');

  const row = await prisma.apiKey.update({
    where: { id },
    data: { isActive },
    include: { createdBy: { select: { id: true, name: true } } },
  });

  await logActivity({ userId: actorId, action: isActive ? 'api_key.activated' : 'api_key.deactivated', entityType: 'ApiKey', entityId: id, req });

  return toPublicShape(row);
}

export async function deleteApiKey(id: string, actorId: string, req?: Request) {
  const existing = await prisma.apiKey.findUnique({ where: { id } });
  if (!existing) throw AppError.notFound('API key not found');

  await prisma.apiKey.delete({ where: { id } });

  await logActivity({ userId: actorId, action: 'api_key.deleted', entityType: 'ApiKey', entityId: id, metadata: { service: existing.service, label: existing.label }, req });
}

/**
 * Deactivates every currently-active key across all services in one
 * action — the real, honest version of a "danger zone" bulk operation.
 * There's no real "rotate all keys" equivalent: rotation needs a NEW
 * value per key, and this app has no way to generate a fresh Gemini or
 * Drive credential on someone's behalf — that value has to come from the
 * provider. Deactivation, by contrast, needs no external input, so it's
 * the one bulk action that's actually possible to build for real.
 */
export async function deactivateAllKeys(actorId: string, req?: Request): Promise<{ deactivatedCount: number }> {
  const activeKeys = await prisma.apiKey.findMany({ where: { isActive: true } });
  for (const key of activeKeys) {
    await prisma.apiKey.update({ where: { id: key.id }, data: { isActive: false } });
  }

  await logActivity({
    userId: actorId,
    action: 'api_key.deactivated_all',
    metadata: { count: activeKeys.length, keyIds: activeKeys.map((k) => k.id) },
    req,
  });

  return { deactivatedCount: activeKeys.length };
}

/**
 * Resolves the plaintext value of the active key for a service — used
 * internally by clients (Gemini, Drive) that need the real secret to make
 * a call. Never exposed via any HTTP response; only ever read server-side.
 * Returns null if no active DB-stored key exists for that service, so
 * callers can fall back to their env-var config.
 */
export async function resolveActiveKeyValue(service: string): Promise<string | null> {
  const row = await prisma.apiKey.findFirst({ where: { service, isActive: true }, orderBy: { updatedAt: 'desc' } });
  if (!row) return null;
  try {
    return decryptSecret(row.encryptedValue, encryptionKey);
  } catch {
    return null;
  }
}
