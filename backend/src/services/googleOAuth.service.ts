/**
 * GOOGLE OAUTH FOR DRIVE -- the studio's own Gmail, not a robot.
 *
 * WHY THIS EXISTS. The library stores its pictures in a folder in a
 * personal Google Drive. A service account cannot put anything there:
 * it owns no storage quota at all, so Drive refuses to let it own the
 * file it would create, however the folder is shared. Google's own
 * error names the two ways out -- a shared drive, which needs a paid
 * Workspace, or OAuth delegation. This is the second, in the only form
 * a personal Gmail can use: the owner signs in once, and the
 * application afterwards acts as them, with files owned by them and
 * stored against their fifteen gigabytes.
 *
 * THE SHAPE. An Authorization Code flow with access_type=offline, run
 * entirely server-side. The browser only ever sees Google's consent
 * page and, at the end, a success page: the client secret, the
 * authorization code and the refresh token never reach it.
 *
 * WHERE THE REFRESH TOKEN LIVES. In the api_keys table, encrypted with
 * AES-256-GCM under the app's ENCRYPTION_KEY, exactly as the Gemini key
 * already is -- so no schema change, and no new secret store to get
 * wrong. GOOGLE_OAUTH_REFRESH_TOKEN is read as a fallback for a
 * deployment that would rather keep it in the environment.
 *
 * WHICH SCOPE. drive.file by default: it is not a sensitive scope, so
 * Google asks for no verification and no security assessment, and a
 * published app's refresh token does not expire. The price is that the
 * application can only touch what it created or what the owner handed
 * it through the Google Picker -- which is why there is a Picker page
 * for the one existing folder. GOOGLE_OAUTH_SCOPE can be set to the
 * full https://www.googleapis.com/auth/drive instead, which reaches the
 * existing folder with no Picker step but is a RESTRICTED scope: the
 * app then shows an "unverified" warning and Google may require a CASA
 * security assessment before it will verify it.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import crypto from 'crypto';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';
import { encryptSecret, decryptSecret, deriveEncryptionKey } from '@utils/crypto';

/** The api_keys row this lives in. One row; rotating it replaces it. */
export const OAUTH_SERVICE = 'google_drive_oauth';
const OAUTH_LABEL = 'Google Drive (owner OAuth)';

const encryptionKey = deriveEncryptionKey(config.auth.encryptionKey);

/**
 * Read once per process, not once per upload: a hundred-picture batch
 * would otherwise be a hundred extra queries inside a sixty-second
 * function. Cleared whenever the grant changes, and whenever Google
 * tells us the token is dead.
 */
let cachedRefreshToken: string | null = null;
let cachedClient: OAuth2Client | null = null;

export function clearOAuthCache(): void {
  cachedRefreshToken = null;
  cachedClient = null;
}

/** Client id and secret are set, so the flow can at least be started. */
export function isOAuthConfigured(): boolean {
  return !!config.google.oauthClientId && !!config.google.oauthClientSecret;
}

export function oauthScopes(): string[] {
  return config.google.oauthScope.split(/[\s,]+/).filter(Boolean);
}

/**
 * THE CALLBACK GOOGLE IS SENT BACK TO. Registered in the Cloud console
 * as an Authorized redirect URI, character for character.
 *
 * Derived from BACKEND_PUBLIC_URL so a deployment that already knows
 * its own address needs no second setting, and overridable with
 * GOOGLE_OAUTH_REDIRECT_URI for the cases where it does not (a
 * preview URL, a tunnel).
 */
export const OAUTH_CALLBACK_PATH = `${config.app.apiPrefix}/integrations/google/callback`;

export function oauthRedirectUri(): string {
  if (config.google.oauthRedirectUri) return config.google.oauthRedirectUri;
  const base = (config.backend.publicUrl || '').replace(/\/+$/, '');
  return base ? `${base}${OAUTH_CALLBACK_PATH}` : '';
}

function newClient(): OAuth2Client {
  if (!isOAuthConfigured()) {
    throw AppError.badRequest(
      'Google OAuth is not configured. Set GOOGLE_OAUTH_CLIENT_ID and '
      + 'GOOGLE_OAUTH_CLIENT_SECRET (a Web application OAuth client in the Google Cloud '
      + 'console), and register the callback URL as an Authorized redirect URI.',
    );
  }
  const redirectUri = oauthRedirectUri();
  if (!redirectUri) {
    throw AppError.badRequest(
      'Google OAuth has no redirect URI. Set BACKEND_PUBLIC_URL to this deployment’s '
      + `address (the callback is then ${OAUTH_CALLBACK_PATH}), or set `
      + 'GOOGLE_OAUTH_REDIRECT_URI to the exact URL registered in the Google Cloud console.',
    );
  }
  return new google.auth.OAuth2(
    config.google.oauthClientId,
    config.google.oauthClientSecret,
    redirectUri,
  );
}

// ── The state parameter ──────────────────────────────────────────────
//
// The callback is a top-level browser navigation from Google, so it
// carries no Authorization header and cannot be behind the normal
// authenticate/authorize middleware. Instead the owner's identity is
// signed into `state` when the flow starts and verified when it comes
// back: an unsigned or expired state is refused, so the callback cannot
// be driven by anybody who did not start the flow here.

const STATE_TTL_MS = 15 * 60 * 1000;

export function signState(userId: string, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ u: userId, t: now, n: crypto.randomBytes(8).toString('hex') }))
    .toString('base64url');
  const mac = crypto.createHmac('sha256', config.auth.jwtSecret).update(payload).digest('base64url');
  return `${payload}.${mac}`;
}

export function verifyState(state: string, now = Date.now()): { userId: string } {
  const [payload, mac] = String(state || '').split('.');
  if (!payload || !mac) throw AppError.badRequest('The sign-in could not be completed: its state is missing.');

  const expected = crypto.createHmac('sha256', config.auth.jwtSecret).update(payload).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw AppError.badRequest('The sign-in could not be completed: its state did not verify.');
  }

  let parsed: { u?: string; t?: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw AppError.badRequest('The sign-in could not be completed: its state is unreadable.');
  }

  if (!parsed.u || typeof parsed.t !== 'number' || now - parsed.t > STATE_TTL_MS) {
    throw AppError.badRequest('The sign-in took too long and has expired. Start it again.');
  }
  return { userId: parsed.u };
}

/**
 * Google's consent URL.
 *
 * prompt=consent is deliberate: Google returns a refresh token only on
 * the first authorization for a client, so re-connecting without it
 * would hand back an access token and nothing to store.
 */
export function buildAuthUrl(userId: string): string {
  return newClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: true,
    scope: oauthScopes(),
    state: signState(userId),
  });
}

/** Exchanges the one-time code for a refresh token and stores it. */
export async function completeAuthorization(code: string, userId: string): Promise<{ scope: string }> {
  const client = newClient();

  let tokens;
  try {
    ({ tokens } = await client.getToken(code));
  } catch (err) {
    throw AppError.badRequest(`Google refused the authorization code: ${describeOAuthError(err)}`);
  }

  if (!tokens.refresh_token) {
    throw AppError.badRequest(
      'Google returned no refresh token. That happens when this Google account has already '
      + 'authorized this app: remove it at https://myaccount.google.com/permissions and '
      + 'connect again.',
    );
  }

  await storeRefreshToken(tokens.refresh_token, userId);
  return { scope: tokens.scope || oauthScopes().join(' ') };
}

export async function storeRefreshToken(refreshToken: string, userId?: string): Promise<void> {
  const encryptedValue = encryptSecret(refreshToken, encryptionKey);
  const existing = await prisma.apiKey.findFirst({ where: { service: OAUTH_SERVICE } });

  if (existing) {
    await prisma.apiKey.update({
      where: { id: existing.id },
      data: { encryptedValue, isActive: true, lastRotatedAt: new Date(), label: OAUTH_LABEL },
    });
  } else {
    await prisma.apiKey.create({
      data: { service: OAUTH_SERVICE, label: OAUTH_LABEL, encryptedValue, createdById: userId ?? null },
    });
  }
  clearOAuthCache();
}

export async function forgetRefreshToken(): Promise<void> {
  await prisma.apiKey.deleteMany({ where: { service: OAUTH_SERVICE } });
  clearOAuthCache();
}

/**
 * The stored refresh token, or ''. The database first -- that is what
 * the callback writes and what a re-connection rotates -- then the
 * environment, for a deployment that prefers to keep it there.
 *
 * A database that is unreachable or un-migrated must not take Drive
 * down with it, so the lookup is best-effort.
 */
export async function readRefreshToken(): Promise<string> {
  if (cachedRefreshToken !== null) return cachedRefreshToken;

  let fromDb = '';
  try {
    const row = await prisma.apiKey.findFirst({
      where: { service: OAUTH_SERVICE, isActive: true },
      orderBy: { updatedAt: 'desc' },
    });
    if (row) fromDb = decryptSecret(row.encryptedValue, encryptionKey);
  } catch (err) {
    logger.warn(`Google OAuth: stored refresh token could not be read (${err instanceof Error ? err.message : String(err)})`);
  }

  const token = fromDb || config.google.oauthRefreshToken || '';

  // ONLY A TOKEN IS REMEMBERED, never its absence. Each serverless
  // instance has its own copy of this, and one that answered a request
  // before the owner connected would otherwise go on insisting the
  // account is unconnected for as long as it stays warm -- which is
  // exactly the minute after connecting, when the owner uploads.
  if (token) cachedRefreshToken = token;
  return token;
}

export async function isOAuthAuthorized(): Promise<boolean> {
  if (!isOAuthConfigured()) return false;
  return !!(await readRefreshToken());
}

/**
 * An authenticated client, ready to be handed to google.drive().
 *
 * google-auth-library refreshes the access token on its own whenever
 * the one it holds is missing or expired, so nothing above this has to
 * think about expiry; the client is kept for the life of the process so
 * that a batch of uploads refreshes once rather than per picture.
 */
export async function getOAuthClient(): Promise<OAuth2Client> {
  if (cachedClient) return cachedClient;

  const refreshToken = await readRefreshToken();
  if (!refreshToken) {
    throw AppError.badRequest(
      'Google Drive has not been connected yet. Open the owner’s Drive settings and '
      + 'connect the studio’s Google account.',
    );
  }

  const client = newClient();
  client.setCredentials({ refresh_token: refreshToken });
  cachedClient = client;
  return client;
}

/**
 * Google's OAuth errors in one sentence.
 *
 * invalid_grant is the one that matters: the refresh token has been
 * revoked, or expired because the OAuth app is still in "Testing"
 * (Google expires those after seven days). Nothing retries its way out
 * of it -- the owner has to connect again -- so the cache is dropped
 * and the message says so.
 */
export function describeOAuthError(err: unknown): string {
  const e = err as { response?: { data?: { error?: string; error_description?: string } }; message?: string };
  const code = e.response?.data?.error;
  const detail = e.response?.data?.error_description || e.message || 'unknown error';

  if (code === 'invalid_grant') {
    clearOAuthCache();
    return 'the stored Google authorization is no longer valid (invalid_grant) — it was '
      + 'revoked, or the OAuth app is still in "Testing", where Google expires refresh tokens '
      + 'after seven days. Publish the app and connect the studio’s Google account again.';
  }
  if (code) return `${code}: ${detail}`;
  return detail;
}
