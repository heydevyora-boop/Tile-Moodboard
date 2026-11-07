import { Readable } from 'stream';
import { google, drive_v3 } from 'googleapis';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';
import { retryWithBackoff } from '@utils/retry';
import {
  isOAuthConfigured,
  isOAuthAuthorized,
  getOAuthClient,
  describeOAuthError,
} from './googleOAuth.service';

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

/**
 * THE FAILURE A STUDIO ACTUALLY HITS, in words it can act on.
 *
 * Google's own text for it is "Service Accounts do not have storage
 * quota. Leverage shared drives ... or use OAuth delegation ...", with
 * two documentation links -- accurate, and unreadable as an answer to
 * "why did my photograph not upload?". It is not a permission problem
 * and no amount of re-sharing the folder fixes it: a service account
 * owns no Drive storage at all, so any file it would OWN is refused.
 * Only two configurations avoid that, and both are named here.
 */
export const SERVICE_ACCOUNT_NO_QUOTA =
  'a service account owns no Google Drive storage of its own, so Drive refuses to let it '
  + 'create a file that it would own. Sharing a My Drive folder with it \u2014 even as an '
  + 'Editor \u2014 does not change that, because the uploaded file would still belong to the '
  + 'service account. Two configurations work: move the library folder onto a SHARED DRIVE '
  + '(Google Workspace) and add the service account to that drive as a Content manager, or '
  + 'set GOOGLE_DRIVE_IMPERSONATE_USER to a mailbox on the studio\u2019s Workspace domain and '
  + 'grant the service account domain-wide delegation for the Drive scope, so that it '
  + 'uploads as that person and the files are owned by them.';

const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError', 'internalError']);

function classifyError(err: unknown): DriveError {
  const gaxiosErr = err as {
    response?: {
      status?: number;
      // Drive's own errors carry an object here; the OAuth token
      // endpoint answers with a string ("invalid_grant") instead.
      data?: { error?: { errors?: { reason?: string }[]; message?: string } | string };
    };
    code?: number | string;
    message?: string;
  };
  const status = gaxiosErr.response?.status ?? (typeof gaxiosErr.code === 'number' ? gaxiosErr.code : undefined);
  const data = gaxiosErr.response?.data;

  // THE TOKEN ITSELF FAILED, not the Drive call. google-auth-library
  // refreshes the access token underneath every request, so a revoked
  // or expired authorization arrives here rather than anywhere the
  // owner would think to look. Retrying cannot fix it: the owner has
  // to connect the Google account again, and the message says so.
  if (typeof data?.error === 'string') {
    return new DriveError(`Google Drive could not authenticate: ${describeOAuthError(err)}`, 401, false);
  }

  const reason = data?.error?.errors?.[0]?.reason;
  const message = data?.error?.message ?? gaxiosErr.message ?? 'Google Drive request failed';

  // Checked before everything else: it arrives as a 403, which would
  // otherwise be reported as a permission error and send the studio off
  // to re-share a folder that is already shared correctly.
  if (reason === 'storageQuotaExceeded' || /do not have storage quota/i.test(message)) {
    return new DriveError(`Google Drive refused the upload: ${SERVICE_ACCOUNT_NO_QUOTA}`, 400, false);
  }

  if (reason && RETRYABLE_REASONS.has(reason)) {
    return new DriveError(`Google Drive: ${message}`, 429, true);
  }
  if (status === 429) return new DriveError(`Google Drive rate limit: ${message}`, 429, true);
  if (status !== undefined && status >= 500) return new DriveError(`Google Drive server error: ${message}`, 502, true);
  if (status === 401 || status === 403) return new DriveError(`Google Drive authentication/permission error: ${message}`, status, false);
  if (status === 404) return new DriveError(`Google Drive: file or folder not found: ${message}`, 404, false);
  return new DriveError(`Google Drive: ${message}`, 400, false);
}

/**
 * Reads the service-account credentials out of GOOGLE_SERVICE_ACCOUNT_JSON.
 * Accepts either the raw JSON or a base64 blob of it, because pasting raw
 * JSON into a dashboard env var frequently mangles the private key's
 * newlines; literal "\n" sequences are restored for the same reason.
 *
 * Returns the full parsed key object (repaired), not just the two fields
 * this module's own GoogleAuth() call needs -- catalogExtractor.service.ts
 * reuses this to materialize a real service-account key *file* for
 * extract.py, which (via google.oauth2.service_account.Credentials.
 * from_service_account_file) needs the complete key document, not a
 * client_email/private_key subset.
 */
export function parseServiceAccountJson(raw: string): Record<string, unknown> & { client_email: string; private_key: string } {
  const trimmed = raw.trim();
  const decoded = trimmed.startsWith('{')
    ? trimmed
    : Buffer.from(trimmed, 'base64').toString('utf8');

  let parsed: Record<string, unknown> & { client_email?: string; private_key?: string };
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw AppError.internal('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole service-account key file, or its base64)');
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw AppError.internal('GOOGLE_SERVICE_ACCOUNT_JSON is missing client_email or private_key');
  }

  return { ...parsed, client_email: parsed.client_email, private_key: parsed.private_key.replace(/\\n/g, '\n') };
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
  /**
   * The id of the SHARED DRIVE this item lives on, when it lives on
   * one. Absent for anything in somebody's My Drive -- including a
   * My Drive folder shared with this credential.
   *
   * It is the one fact that decides whether an upload can succeed at
   * all: a file created on a shared drive is owned by that drive, a
   * file created in a My Drive is owned by whoever created it, and a
   * service account cannot own anything. Only getFolderById asks for
   * it, because only the configured folder is checked this way.
   */
  driveId?: string;
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
    return !!this.driveOverride
      || isOAuthConfigured()
      || !!config.google.serviceAccountKeyPath
      || !!config.google.serviceAccountJson;
  }

  /**
   * WHICH CREDENTIAL THIS DEPLOYMENT WILL ACTUALLY USE.
   *
   *   oauth              the studio's own Google account, authorized
   *                      once. Files are owned by them, so they can
   *                      live in an ordinary My Drive folder.
   *   service-account    a robot that owns no storage. It can only
   *                      write to a shared drive.
   *   delegated          a service account acting as a Workspace user
   *                      (GOOGLE_DRIVE_IMPERSONATE_USER).
   *
   * OAuth is preferred when it is connected, and the service account
   * stays as the fallback underneath it -- nothing that works today
   * stops working because OAuth was configured and not yet finished.
   */
  async authMode(): Promise<'oauth' | 'delegated' | 'service-account' | 'none'> {
    if (this.driveOverride) return 'service-account';
    if (await isOAuthAuthorized()) return 'oauth';
    if (config.google.serviceAccountKeyPath || config.google.serviceAccountJson) {
      return config.google.driveImpersonateUser ? 'delegated' : 'service-account';
    }
    return 'none';
  }

  /** Forgets the built client -- after the owner connects or disconnects. */
  resetAuth(): void {
    if (!this.driveOverride) this.cachedDrive = null;
  }

  private async getDrive(): Promise<DriveApiClient> {
    if (this.cachedDrive) return this.cachedDrive;

    // THE OWNER'S OWN ACCOUNT FIRST, when it has been connected. It is
    // the only credential that can own a file in a personal My Drive,
    // which is where the studio's library folder lives.
    if (await isOAuthAuthorized()) {
      const auth = await getOAuthClient();
      this.cachedDrive = google.drive({ version: 'v3', auth }) as unknown as DriveApiClient;
      return this.cachedDrive;
    }

    if (!config.google.serviceAccountKeyPath && !config.google.serviceAccountJson) {
      throw AppError.badRequest(
        isOAuthConfigured()
          ? 'Google Drive has not been connected yet: the OAuth client is configured but the '
            + 'studio\u2019s Google account has not authorized it. Connect it from the owner\u2019s '
            + 'Drive settings.'
          : 'Google Drive is not configured (connect the studio\u2019s Google account, or set '
            + 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH / GOOGLE_SERVICE_ACCOUNT_JSON)',
      );
    }
    const scopes = ['https://www.googleapis.com/auth/drive'];

    // keyFile stays first so existing Docker/local deployments keep the
    // exact behaviour they had. The JSON variant is only consulted when no
    // key path is set -- see GOOGLE_SERVICE_ACCOUNT_JSON in config/env.ts.

    // OAUTH DELEGATION, when the studio has configured it. With a
    // subject the credential stops acting as the service account and
    // acts as that person instead, which is the only way a file can be
    // uploaded into a My Drive and owned by somebody who has storage.
    // Unset -- the default -- this is undefined and nothing changes.
    const clientOptions = config.google.driveImpersonateUser
      ? { subject: config.google.driveImpersonateUser }
      : undefined;

    const auth = config.google.serviceAccountKeyPath
      ? new google.auth.GoogleAuth({ keyFile: config.google.serviceAccountKeyPath, scopes, clientOptions })
      : new google.auth.GoogleAuth({ credentials: parseServiceAccountJson(config.google.serviceAccountJson as string), scopes, clientOptions });
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
    const drive = await this.getDrive();

    const parentClause = parentFolderId ? ` and '${parentFolderId}' in parents` : '';
    const escapedName = name.replace(/'/g, "\\'");
    const q = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed=false${parentClause}`;

    const res = await this.withRetry(() =>
      drive.files.list({
        q,
        fields: 'files(id,name)',
        pageSize: 1,
        // Without these two a folder on a shared drive is simply not
        // found, and get-or-create would answer by creating a second
        // one -- in a My Drive, where the upload then fails.
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    const file = res.data.files?.[0];
    return file?.id ? { id: file.id, name: file.name ?? name } : null;
  }

  async createFolder(name: string, parentFolderId?: string): Promise<DriveFile> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentFolderId ? [parentFolderId] : undefined },
        fields: 'id,name',
        supportsAllDrives: true,
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

  /**
   * One folder, by id, or null when this credential cannot see it.
   *
   * findFolder searches by NAME inside a parent, which cannot answer
   * "is this id a real folder I can write to?" -- and that is the
   * question a configured folder id raises. Without it, a wrong or
   * unshared id fails at the moment of upload with Google's own
   * generic error and nothing to say which setting is at fault.
   *
   * It returns null for "not found or not visible" rather than
   * throwing, because for this caller those are the same answer and
   * both have the same remedy: share the folder with the service
   * account, or correct the id.
   */
  async getFolderById(folderId: string): Promise<DriveFile | null> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    try {
      const res = await this.withRetry(() =>
        drive.files.get({
          fileId: folderId,
          // driveId answers "can anything actually be stored in here?"
          // -- see DriveFile.driveId.
          fields: 'id,name,mimeType,trashed,driveId',
          // A folder on a Shared Drive is invisible without this, and a
          // Shared Drive is exactly where a service account's files can
          // live -- so omitting it would reject the very configuration
          // that makes uploads work at all.
          supportsAllDrives: true,
        }),
      );

      const file = res.data;
      if (!file?.id) return null;
      if (file.trashed) return null;
      if (file.mimeType !== 'application/vnd.google-apps.folder') return null;

      return { id: file.id, name: file.name ?? '(untitled)', driveId: file.driveId ?? undefined };
    } catch {
      return null;
    }
  }

  async listFolderContents(folderId: string): Promise<DriveFile[]> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.list({
        q: `'${folderId}' in parents and trashed=false`,
        fields: 'files(id,name,webViewLink)',
        pageSize: 100,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    );
    return (res.data.files ?? [])
      .filter((f): f is { id: string; name?: string | null; webViewLink?: string | null } => !!f.id)
      .map((f) => ({ id: f.id, name: f.name ?? '(untitled)', webViewLink: f.webViewLink ?? undefined }));
  }

  // ── Upload / Delete ──────────────────────────────────────────────────

  async uploadFile(input: UploadFileInput): Promise<DriveFile> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.create({
        requestBody: { name: input.name, parents: input.parentFolderId ? [input.parentFolderId] : undefined },
        media: { mimeType: input.mimeType, body: Readable.from(input.content) },
        fields: 'id,name,webViewLink',
        // THE FLAG THE WHOLE LIBRARY DEPENDS ON. A shared drive is the
        // only place a service account's upload can be stored, and
        // without this the request is handled as if shared drives did
        // not exist -- so the file is refused for want of quota.
        supportsAllDrives: true,
      }),
    );
    if (!res.data.id) throw new DriveError('Google Drive did not return an id for the uploaded file', 502, false);
    return { id: res.data.id, name: res.data.name ?? input.name, webViewLink: res.data.webViewLink ?? undefined };
  }

  async deleteFile(fileId: string): Promise<void> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();
    await this.withRetry(() => drive.files.delete({ fileId, supportsAllDrives: true }));
  }

  // ── Generate Public Links ────────────────────────────────────────────

  /** Grants "anyone with the link can view" and returns the shareable URL. Idempotent — re-sharing an already-public file just re-confirms the permission. */
  async generatePublicLink(fileId: string): Promise<string> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    await this.withRetry(() =>
      drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' }, supportsAllDrives: true }),
    );
    const res = await this.withRetry(() => drive.files.get({ fileId, fields: 'webViewLink', supportsAllDrives: true }));

    if (!res.data.webViewLink) throw new DriveError('Google Drive did not return a shareable link after making the file public', 502, false);
    return res.data.webViewLink;
  }

  /** Lightweight live connectivity check — used by the admin integrations status endpoint. Confirms credentials actually work by finding-or-creating the configured root folder. */
  async testConnection(): Promise<{ ok: boolean; latencyMs: number; message?: string }> {
    const start = Date.now();
    if (!this.isConfigured()) {
      return { ok: false, latencyMs: 0, message: 'Neither GOOGLE_SERVICE_ACCOUNT_KEY_PATH nor GOOGLE_SERVICE_ACCOUNT_JSON is set' };
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
