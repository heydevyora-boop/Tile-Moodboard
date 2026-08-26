import { Readable } from 'stream';
import { google, drive_v3 } from 'googleapis';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';
import { retryWithBackoff } from '@utils/retry';

/**
 * Same retryable/permanent split as Module 12's GeminiError, for the
 * same reason: retrying a permissions error or a bad file id wastes
 * time and still fails, while rate limits and transient 5xx genuinely
 * recover on retry.
 */
export class DriveError extends AppError {
  public readonly retryable: boolean;

  constructor(message: string, statusCode: number, retryable: boolean) {
    super(message, statusCode);
    this.retryable = retryable;
  }
}

const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError', 'internalError']);

function classifyError(err: unknown): DriveError {
  const gaxiosErr = err as { response?: { status?: number; data?: { error?: { errors?: { reason?: string }[]; message?: string } } }; code?: number | string; message?: string };
  const status = gaxiosErr.response?.status ?? (typeof gaxiosErr.code === 'number' ? gaxiosErr.code : undefined);
  const reason = gaxiosErr.response?.data?.error?.errors?.[0]?.reason;
  const message = gaxiosErr.response?.data?.error?.message ?? gaxiosErr.message ?? 'Google Drive request failed';

  if (reason && RETRYABLE_REASONS.has(reason)) {
    return new DriveError(`Google Drive: ${message}`, 429, true);
  }
  if (status === 429) return new DriveError(`Google Drive rate limit: ${message}`, 429, true);
  if (status !== undefined && status >= 500) return new DriveError(`Google Drive server error: ${message}`, 502, true);
  if (status === 401 || status === 403) return new DriveError(`Google Drive authentication/permission error: ${message}`, status, false);
  if (status === 404) return new DriveError(`Google Drive: file or folder not found: ${message}`, 404, false);
  return new DriveError(`Google Drive: ${message}`, 400, false);
}

export interface UploadFileInput {
  name: string;
  mimeType: string;
  content: Buffer;
  parentFolderId?: string;
}

export interface DriveFile {
  id: string;
  name: string;
  webViewLink?: string;
}

/** Minimal structural subset of drive_v3.Drive this client actually uses — lets tests inject a fake without depending on googleapis' full type surface. */
export interface DriveApiClient {
  files: {
    create: drive_v3.Drive['files']['create'];
    delete: drive_v3.Drive['files']['delete'];
    list: drive_v3.Drive['files']['list'];
    get: drive_v3.Drive['files']['get'];
  };
  permissions: {
    create: drive_v3.Drive['permissions']['create'];
  };
}

export class GoogleDriveClient {
  private cachedDrive: DriveApiClient | null;

  /** driveOverride lets tests inject a fake Drive API without real credentials — same reasoning as GeminiClient's apiKeyOverride. */
  constructor(private readonly driveOverride?: DriveApiClient) {
    this.cachedDrive = driveOverride ?? null;
  }

  isConfigured(): boolean {
    return !!this.driveOverride || !!config.google.serviceAccountKeyPath;
  }

  private getDrive(): DriveApiClient {
    if (this.cachedDrive) return this.cachedDrive;
    if (!config.google.serviceAccountKeyPath) {
      throw AppError.internal('Google Drive is not configured (set GOOGLE_SERVICE_ACCOUNT_KEY_PATH)');
    }
    const auth = new google.auth.GoogleAuth({
      keyFile: config.google.serviceAccountKeyPath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
    this.cachedDrive = google.drive({ version: 'v3', auth }) as unknown as DriveApiClient;
    return this.cachedDrive;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(
      async () => {
        try {
          return await fn();
        } catch (err) {
          throw classifyError(err);
        }
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        isRetryable: (err) => err instanceof DriveError && err.retryable,
        onRetry: (attempt, err) => {
          const message = err instanceof Error ? err.message : String(err);
          logger.warn(`Google Drive request retry ${attempt}/3: ${message}`);
        },
      },
    );
  }

  // ── Folder Management ────────────────────────────────────────────────

  /** Finds a folder by exact name within an optional parent — the read half of get-or-create. */
  async findFolder(name: string, parentFolderId?: string): Promise<DriveFile | null> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();

    const parentClause = parentFolderId ? ` and '${parentFolderId}' in parents` : '';
    const escapedName = name.replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed=false${parentClause}`;

    const res = await this.withRetry(() => drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 }));
    const file = res.data.files?.[0];
    return file?.id ? { id: file.id, name: file.name ?? name } : null;
  }

  async createFolder(name: string, parentFolderId?: string): Promise<DriveFile> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentFolderId ? [parentFolderId] : undefined },
        fields: 'id,name',
      }),
    );
    if (!res.data.id) throw new DriveError('Google Drive did not return an id for the created folder', 502, false);
    return { id: res.data.id, name: res.data.name ?? name };
  }

  /** Real folder management: reuses an existing folder by name rather than creating duplicates on every call. */
  async getOrCreateFolder(name: string, parentFolderId?: string): Promise<DriveFile> {
    const existing = await this.findFolder(name, parentFolderId);
    if (existing) return existing;
    return this.createFolder(name, parentFolderId);
  }

  async listFolderContents(folderId: string): Promise<DriveFile[]> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,webViewLink)', pageSize: 100 }),
    );
    return (res.data.files ?? [])
      .filter((f): f is { id: string; name?: string | null; webViewLink?: string | null } => !!f.id)
      .map((f) => ({ id: f.id, name: f.name ?? '(untitled)', webViewLink: f.webViewLink ?? undefined }));
  }

  // ── Upload / Delete ──────────────────────────────────────────────────

  async uploadFile(input: UploadFileInput): Promise<DriveFile> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.create({
        requestBody: { name: input.name, parents: input.parentFolderId ? [input.parentFolderId] : undefined },
        media: { mimeType: input.mimeType, body: Readable.from(input.content) },
        fields: 'id,name,webViewLink',
      }),
    );
    if (!res.data.id) throw new DriveError('Google Drive did not return an id for the uploaded file', 502, false);
    return { id: res.data.id, name: res.data.name ?? input.name, webViewLink: res.data.webViewLink ?? undefined };
  }

  async deleteFile(fileId: string): Promise<void> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();
    await this.withRetry(() => drive.files.delete({ fileId }));
  }

  // ── Generate Public Links ────────────────────────────────────────────

  /** Grants "anyone with the link can view" and returns the shareable URL. Idempotent — re-sharing an already-public file just re-confirms the permission. */
  async generatePublicLink(fileId: string): Promise<string> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = this.getDrive();

    await this.withRetry(() => drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } }));
    const res = await this.withRetry(() => drive.files.get({ fileId, fields: 'webViewLink' }));

    if (!res.data.webViewLink) throw new DriveError('Google Drive did not return a shareable link after making the file public', 502, false);
    return res.data.webViewLink;
  }

  /** Lightweight live connectivity check — used by the admin integrations status endpoint. Confirms credentials actually work by finding-or-creating the configured root folder. */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, message: 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set' };
    }
    try {
      await this.getOrCreateFolder(config.google.driveRootFolder);
      return { ok: true, latencyMs: Date.now() - start };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, latencyMs: Date.now() - start, message };
    }
  }
}

export const googleDriveClient = new GoogleDriveClient();
