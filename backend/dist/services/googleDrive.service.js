"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.googleDriveClient = exports.GoogleDriveClient = exports.DriveError = void 0;
const stream_1 = require("stream");
const googleapis_1 = require("googleapis");
const index_1 = require("@config/index");
const AppError_1 = require("@utils/AppError");
const logger_1 = require("@utils/logger");
const retry_1 = require("@utils/retry");
class DriveError extends AppError_1.AppError {
    constructor(message, statusCode, retryable) {
        super(message, statusCode);
        this.retryable = retryable;
    }
}
exports.DriveError = DriveError;
const RETRYABLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'backendError', 'internalError']);
function classifyError(err) {
    const gaxiosErr = err;
    const status = gaxiosErr.response?.status ?? (typeof gaxiosErr.code === 'number' ? gaxiosErr.code : undefined);
    const reason = gaxiosErr.response?.data?.error?.errors?.[0]?.reason;
    const message = gaxiosErr.response?.data?.error?.message ?? gaxiosErr.message ?? 'Google Drive request failed';
    if (reason && RETRYABLE_REASONS.has(reason)) {
        return new DriveError(`Google Drive: ${message}`, 429, true);
    }
    if (status === 429)
        return new DriveError(`Google Drive rate limit: ${message}`, 429, true);
    if (status !== undefined && status >= 500)
        return new DriveError(`Google Drive server error: ${message}`, 502, true);
    if (status === 401 || status === 403)
        return new DriveError(`Google Drive authentication/permission error: ${message}`, status, false);
    if (status === 404)
        return new DriveError(`Google Drive: file or folder not found: ${message}`, 404, false);
    return new DriveError(`Google Drive: ${message}`, 400, false);
}
class GoogleDriveClient {
    constructor(driveOverride) {
        this.driveOverride = driveOverride;
        this.cachedDrive = driveOverride ?? null;
    }
    isConfigured() {
        return !!this.driveOverride || !!index_1.config.google.serviceAccountKeyPath;
    }
    getDrive() {
        if (this.cachedDrive)
            return this.cachedDrive;
        if (!index_1.config.google.serviceAccountKeyPath) {
            throw AppError_1.AppError.internal('Google Drive is not configured (set GOOGLE_SERVICE_ACCOUNT_KEY_PATH)');
        }
        const auth = new googleapis_1.google.auth.GoogleAuth({
            keyFile: index_1.config.google.serviceAccountKeyPath,
            scopes: ['https://www.googleapis.com/auth/drive'],
        });
        this.cachedDrive = googleapis_1.google.drive({ version: 'v3', auth });
        return this.cachedDrive;
    }
    async withRetry(fn) {
        return (0, retry_1.retryWithBackoff)(async () => {
            try {
                return await fn();
            }
            catch (err) {
                throw classifyError(err);
            }
        }, {
            maxRetries: 3,
            baseDelayMs: 1000,
            isRetryable: (err) => err instanceof DriveError && err.retryable,
            onRetry: (attempt, err) => {
                const message = err instanceof Error ? err.message : String(err);
                logger_1.logger.warn(`Google Drive request retry ${attempt}/3: ${message}`);
            },
        });
    }
    async findFolder(name, parentFolderId) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        const parentClause = parentFolderId ? ` and '${parentFolderId}' in parents` : '';
        const escapedName = name.replace(/'/g, "\\'");
        const q = `mimeType='application/vnd.google-apps.folder' and name='${escapedName}' and trashed=false${parentClause}`;
        const res = await this.withRetry(() => drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 }));
        const file = res.data.files?.[0];
        return file?.id ? { id: file.id, name: file.name ?? name } : null;
    }
    async createFolder(name, parentFolderId) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        const res = await this.withRetry(() => drive.files.create({
            requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentFolderId ? [parentFolderId] : undefined },
            fields: 'id,name',
        }));
        if (!res.data.id)
            throw new DriveError('Google Drive did not return an id for the created folder', 502, false);
        return { id: res.data.id, name: res.data.name ?? name };
    }
    async getOrCreateFolder(name, parentFolderId) {
        const existing = await this.findFolder(name, parentFolderId);
        if (existing)
            return existing;
        return this.createFolder(name, parentFolderId);
    }
    async listFolderContents(folderId) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        const res = await this.withRetry(() => drive.files.list({ q: `'${folderId}' in parents and trashed=false`, fields: 'files(id,name,webViewLink)', pageSize: 100 }));
        return (res.data.files ?? [])
            .filter((f) => !!f.id)
            .map((f) => ({ id: f.id, name: f.name ?? '(untitled)', webViewLink: f.webViewLink ?? undefined }));
    }
    async uploadFile(input) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        const res = await this.withRetry(() => drive.files.create({
            requestBody: { name: input.name, parents: input.parentFolderId ? [input.parentFolderId] : undefined },
            media: { mimeType: input.mimeType, body: stream_1.Readable.from(input.content) },
            fields: 'id,name,webViewLink',
        }));
        if (!res.data.id)
            throw new DriveError('Google Drive did not return an id for the uploaded file', 502, false);
        return { id: res.data.id, name: res.data.name ?? input.name, webViewLink: res.data.webViewLink ?? undefined };
    }
    async deleteFile(fileId) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        await this.withRetry(() => drive.files.delete({ fileId }));
    }
    async generatePublicLink(fileId) {
        if (!this.isConfigured())
            throw AppError_1.AppError.internal('Google Drive is not configured');
        const drive = this.getDrive();
        await this.withRetry(() => drive.permissions.create({ fileId, requestBody: { role: 'reader', type: 'anyone' } }));
        const res = await this.withRetry(() => drive.files.get({ fileId, fields: 'webViewLink' }));
        if (!res.data.webViewLink)
            throw new DriveError('Google Drive did not return a shareable link after making the file public', 502, false);
        return res.data.webViewLink;
    }
    async testConnection() {
        const start = Date.now();
        if (!this.isConfigured()) {
            return { ok: false, latencyMs: 0, message: 'GOOGLE_SERVICE_ACCOUNT_KEY_PATH is not set' };
        }
        try {
            await this.getOrCreateFolder(index_1.config.google.driveRootFolder);
            return { ok: true, latencyMs: Date.now() - start };
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { ok: false, latencyMs: Date.now() - start, message };
        }
    }
}
exports.GoogleDriveClient = GoogleDriveClient;
exports.googleDriveClient = new GoogleDriveClient();
//# sourceMappingURL=googleDrive.service.js.map