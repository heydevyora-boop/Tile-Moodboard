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

  /**
   * True when the credential itself failed rather than the request --
   * a revoked or expired authorization. The client built on it is
   * dropped so the next call builds a fresh one from whatever the
   * owner has reconnected, instead of replaying a dead token.
   */
  public readonly authExpired: boolean;

  constructor(message: string, statusCode: number, retryable: boolean, authExpired = false) {
    super(message, statusCode);
    this.retryable = retryable;
    this.authExpired = authExpired;
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
    return new DriveError(`Google Drive could not authenticate: ${describeOAuthError(err)}`, 401, false, true);
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
    /** Reads a file and writes a new one elsewhere; the original is untouched. */
    copy: drive_v3.Drive['files']['copy'];
  };
  permissions: {
    create: drive_v3.Drive['permissions']['create'];
  };
  /** Optional: only the self-test asks who the credential belongs to. */
  about?: {
    get: drive_v3.Drive['about']['get'];
  };
}

export class GoogleDriveClient {
  private cachedDrive: DriveApiClient | null;

  /**
   * WHICH CREDENTIAL THE CACHED CLIENT WAS BUILT FOR.
   *
   * Without this, an instance that served one request before the owner
   * connected keeps its service-account client for as long as it stays
   * warm -- and goes on uploading as an account that owns no storage,
   * while a connected personal account sits there unused. On a
   * serverless host that is not a corner case: the instance that
   * stores the token is rarely the instance that handles the next
   * upload, so the studio would see some uploads work and others fail
   * for no visible reason.
   */
  private cachedDriveMode: 'oauth' | 'service-account' | null = null;

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

  /**
   * WHY THE LAST getFolderById() CAME BACK EMPTY.
   *
   * That method answers null for every kind of failure, because for
   * its caller they all mean "this folder is not usable". But they do
   * not all have the same remedy, and the difference is the whole
   * diagnosis: 404 means this credential has never been granted the
   * folder (with drive.file, that the Picker grant did not take);
   * 403 means it was granted and refused; 401 means the credential
   * itself is dead. Swallowing the error left one sentence blaming
   * the id, the bin, or sharing -- none of which may be true.
   *
   * Set on every call, cleared at the start of one. Empty means the
   * call succeeded or has not run.
   */
  public lastFolderError = '';

  /** Forgets the built client -- after the owner connects or disconnects. */
  resetAuth(): void {
    if (this.driveOverride) return;
    this.cachedDrive = null;
    this.cachedDriveMode = null;
  }

  private async getDrive(): Promise<DriveApiClient> {
    // A test's injected client, or one already built for the owner's
    // own account: nothing better exists, so it is reused as is.
    if (this.driveOverride) return this.driveOverride;
    if (this.cachedDrive && this.cachedDriveMode === 'oauth') return this.cachedDrive;

    // THE OWNER'S OWN ACCOUNT FIRST, when it has been connected. It is
    // the only credential that can own a file in a personal My Drive,
    // which is where the studio's library folder lives.
    //
    // Checked even when a service-account client is already cached --
    // see cachedDriveMode. Falling back is for when there is nothing
    // better; carrying on with the fallback after something better
    // arrived is just a stale cache, and an invisible one.
    if (await isOAuthAuthorized()) {
      const auth = await getOAuthClient();
      this.cachedDrive = google.drive({ version: 'v3', auth }) as unknown as DriveApiClient;
      this.cachedDriveMode = 'oauth';
      return this.cachedDrive;
    }

    if (this.cachedDrive) return this.cachedDrive;

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
    this.cachedDriveMode = 'service-account';
    return this.cachedDrive;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    return retryWithBackoff(
      async () => {
        try {
          return await fn();
        } catch (err) {
          const classified = classifyError(err);
          // The stored authorization died mid-request: the client
          // holding it is no use to the next caller either.
          if (classified.authExpired) this.resetAuth();
          throw classified;
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
    this.lastFolderError = '';

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
      if (!file?.id) {
        this.lastFolderError = 'Google answered without a file.';
        return null;
      }
      if (file.trashed) {
        this.lastFolderError = `“${file.name ?? folderId}” is in the bin.`;
        return null;
      }
      if (file.mimeType !== 'application/vnd.google-apps.folder') {
        this.lastFolderError = `That id is a ${file.mimeType ?? 'file'}, not a folder.`;
        return null;
      }

      return { id: file.id, name: file.name ?? '(untitled)', driveId: file.driveId ?? undefined };
    } catch (err) {
      // GOOGLE'S OWN ANSWER, KEPT. Which status it is decides what to
      // do next, and it was being discarded here.
      const status = err instanceof DriveError ? err.statusCode : 0;
      const message = err instanceof Error ? err.message : String(err);

      this.lastFolderError = status === 404
        ? `Google answered 404 for that id: this credential has never been given access to it. `
          + `With the drive.file scope that is what a folder the Picker has not granted looks `
          + `like — sharing the folder in Drive does not grant it, only the Picker does. `
          + `(${message})`
        : status === 403
          ? `Google answered 403: the credential can see that id but is not allowed to open it. `
            + `(${message})`
          : status === 401
            ? `Google answered 401: the credential itself was rejected. (${message})`
            : message;
      return null;
    }
  }

  /**
   * One file, read back from Drive by id -- what it is called and
   * which folder it is actually in.
   *
   * uploadFile's own answer is Drive's acknowledgement of the request;
   * this is Drive being asked afterwards, independently, whether the
   * file is there and where it landed. The self-test needs the second
   * kind: a 200 on the upload is not evidence that a picture is in the
   * right folder.
   */
  async describeFile(fileId: string): Promise<{ id: string; name: string; parents: string[]; webViewLink?: string } | null> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.get({
        fileId,
        fields: 'id,name,parents,trashed,webViewLink',
        supportsAllDrives: true,
      }),
    );

    const file = res.data;
    if (!file?.id || file.trashed) return null;
    return {
      id: file.id,
      name: file.name ?? '(untitled)',
      parents: file.parents ?? [],
      webViewLink: file.webViewLink ?? undefined,
    };
  }

  /**
   * WHOSE ACCOUNT THIS CREDENTIAL IS.
   *
   * "Which Google account is the server actually acting as?" has been
   * the unanswerable question behind every one of these failures: a
   * folder shared with one account and a request made by another look
   * identical from the outside. Drive will say, so the self-test asks
   * it rather than inferring from configuration.
   *
   * Null when the client cannot answer -- an injected fake, or a
   * credential whose scope does not reach about.get.
   */
  async whoAmI(): Promise<{ email: string; name: string } | null> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();
    if (!drive.about) return null;

    const res = await this.withRetry(() => drive.about!.get({ fields: 'user(emailAddress,displayName)' }));
    const user = res.data?.user;
    if (!user?.emailAddress) return null;
    return { email: user.emailAddress, name: user.displayName ?? '' };
  }

  /**
   * ONE FILE'S BYTES, fetched with this deployment's own credential.
   *
   * Every other way of getting a library picture back out of Drive
   * goes through a public URL, and those have been the whole of this
   * feature's trouble: uc?export=download answers with an HTML page,
   * and anything on drive.google.com is rewritten back to that form
   * further down the pipeline. Asking Drive directly, as the account
   * that owns the file, depends on none of it -- and works whether or
   * not the file was ever shared.
   */
  async downloadFile(fileId: string): Promise<{ bytes: Buffer; mimeType: string }> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const meta = await this.withRetry(() =>
      drive.files.get({ fileId, fields: 'mimeType', supportsAllDrives: true }),
    );

    const media = await this.withRetry(() =>
      drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' },
      ),
    );

    return {
      bytes: Buffer.from(media.data as unknown as ArrayBuffer),
      mimeType: meta.data?.mimeType || 'application/octet-stream',
    };
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

  /**
   * A COPY OF A FILE, INTO ANOTHER FOLDER. The original is not moved,
   * not renamed and not touched: files.copy reads it and writes a new
   * file somewhere else, which is exactly what a client's own folder
   * needs and the only safe thing to do to the studio's library.
   *
   * There is deliberately no "move" anywhere in this client; adding
   * one would make it possible to empty the library by accident.
   */
  async copyFile(fileId: string, name: string, parentFolderId: string): Promise<DriveFile> {
    if (!this.isConfigured()) throw AppError.internal('Google Drive is not configured');
    const drive = await this.getDrive();

    const res = await this.withRetry(() =>
      drive.files.copy({
        fileId,
        requestBody: { name, parents: [parentFolderId] },
        fields: 'id,name,webViewLink',
        // The same flag the uploads depend on: without it a copy into
        // a shared drive is refused for want of quota.
        supportsAllDrives: true,
      }),
    );
    if (!res.data.id) throw new DriveError('Google Drive did not return an id for the copied file', 502, false);
    return { id: res.data.id, name: res.data.name ?? name, webViewLink: res.data.webViewLink ?? undefined };
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
