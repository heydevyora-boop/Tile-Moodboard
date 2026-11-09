import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { config } from '@config/index';
import { describeLibraryFolder } from '@services/library.service';
import { geminiClient } from '@services/gemini.service';
import { googleDriveClient } from '@services/googleDrive.service';
import { checkPythonAIHealth } from '@services/python-ai.service';
import { AppError } from '@utils/AppError';
import { logger } from '@utils/logger';
import {
  OAUTH_CALLBACK_PATH,
  buildAuthUrl,
  completeAuthorization,
  describeOAuthError,
  forgetRefreshToken,
  getOAuthClient,
  isOAuthAuthorized,
  isOAuthConfigured,
  oauthRedirectUri,
  oauthScopes,
  pickerAppId,
  verifyState,
} from '@services/googleOAuth.service';
import { clearLibraryFolderCache, driveFolderIdFrom } from '@services/library.service';
import { toDriveDownloadUrl } from '@services/referenceImages.service';

export const getGeminiStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      configured: await geminiClient.isConfigured(),
      model: config.gemini.model,
      timeoutMs: config.gemini.timeoutMs,
      maxRetries: config.gemini.maxRetries,
      retryBaseDelayMs: config.gemini.retryBaseDelayMs,
      temperature: config.gemini.temperature,
      maxOutputTokens: config.gemini.maxOutputTokens,
    },
  });
});

export const testGeminiConnection = catchAsync(async (_req: Request, res: Response) => {
  const result = await geminiClient.testConnection();
  // Always 200: the test itself succeeded in running, regardless of what
  // it found. Encoding "Gemini is unreachable" as an HTTP error status
  // would make the frontend's generic error handling swallow the actual
  // result.message — this way `data.ok` carries that meaning instead.
  res.status(200).json({ success: true, data: result });
});

export const getDriveStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      configured: googleDriveClient.isConfigured(),
      rootFolder: config.google.driveRootFolder,
      // WHAT THIS DEPLOYMENT ACTUALLY READS for the De'vyora Library's
      // folder, and whether the credential opens it. Without this the
      // only way to tell a variable that was never set from one set on
      // the wrong Vercel environment was to try an upload and read the
      // failure -- after picking the files.
      libraryFolder: await describeLibraryFolder(),
      // WHO THE DEPLOYMENT IS when it writes: the studio's own Google
      // account, or the service account that owns no storage.
      authMode: await googleDriveClient.authMode(),
    },
  });
});

// ════════════════════════════════════════════════════════════════════
// GOOGLE OAUTH -- connecting the studio's own Google account
// ════════════════════════════════════════════════════════════════════

/*
 * A service account cannot own a file, so it cannot put one in a
 * personal My Drive however the folder is shared. These four endpoints
 * are the way out that a personal Gmail actually has: the owner
 * authorizes the application once, and it acts as them afterwards.
 *
 * NOTHING SECRET COMES BACK OUT. The status carries whether a token
 * exists, never the token; the client secret is never sent anywhere;
 * and the one short-lived access token that is returned goes only to
 * the owner, only for the Google Picker, which cannot run without it.
 */

export const getGoogleOAuthStatus = catchAsync(async (_req: Request, res: Response) => {
  const authorized = await isOAuthAuthorized();
  const scopes = oauthScopes();
  res.status(200).json({
    success: true,
    data: {
      configured: isOAuthConfigured(),
      authorized,
      scopes,
      /** drive.file reaches only what the app made or the owner picked. */
      needsPicker: scopes.every((s) => s.endsWith('/drive.file')),
      callbackPath: OAUTH_CALLBACK_PATH,
      redirectUri: oauthRedirectUri(),
      pickerApiKey: config.google.pickerApiKey,
      clientId: config.google.oauthClientId,
      libraryFolderId: driveFolderIdFrom(config.google.driveLibraryFolder),
      authMode: await googleDriveClient.authMode(),
    },
  });
});

export const startGoogleOAuth = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { url: buildAuthUrl(req.user!.id) } });
});

/**
 * Google's redirect lands here. PUBLIC on purpose -- a top-level
 * browser navigation from Google carries no Authorization header --
 * and safe because the owner's identity is signed into `state` when
 * the flow starts and verified here.
 *
 * Answers with a page rather than a redirect: the frontend lives at a
 * different path in each deployment, and a wrong guess would end a
 * successful connection on a 404.
 */
export const googleOAuthCallback = catchAsync(async (req: Request, res: Response) => {
  const page = (title: string, body: string, ok: boolean) => {
    res.status(ok ? 200 : 400).type('html').send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1">`
      + `<title>${title}</title><style>`
      + `body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;`
      + `background:#f6f1e9;color:#2b2520;font:16px/1.6 ui-serif,Georgia,serif;padding:24px}`
      + `.card{max-width:34rem;background:#fffdf9;border:1px solid #e3d9c9;border-radius:18px;padding:32px}`
      + `h1{font-size:1.4rem;margin:0 0 12px}p{margin:0 0 10px}`
      + `code{font:13px ui-monospace,monospace;background:#f0e9dd;padding:2px 6px;border-radius:6px}`
      + `</style></head><body><div class="card"><h1>${title}</h1>${body}</div></body></html>`,
    );
  };

  const error = typeof req.query.error === 'string' ? req.query.error : '';
  if (error) {
    page('Google did not grant access', `<p>Google answered <code>${escapeText(error)}</code>. Nothing was changed. Close this tab and try again from the studio’s Drive settings.</p>`, false);
    return;
  }

  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  if (!code) {
    page('Nothing to complete', '<p>This page is where Google sends you back after you allow access. It was opened without an authorization code, so there is nothing to do here.</p>', false);
    return;
  }

  let userId: string;
  try {
    ({ userId } = verifyState(state));
  } catch (err) {
    page('That sign-in could not be verified', `<p>${escapeText(err instanceof Error ? err.message : String(err))}</p>`, false);
    return;
  }

  try {
    const { scope } = await completeAuthorization(code, userId);
    googleDriveClient.resetAuth();
    clearLibraryFolderCache();
    logger.info('Google Drive OAuth connected');
    page(
      'Google Drive is connected',
      '<p>The De’vyora Library will upload as this Google account from now on, and the '
      + 'pictures will be owned by it.</p>'
      + `<p>Granted: <code>${escapeText(scope)}</code></p>`
      + '<p>You can close this tab and go back to the library.</p>',
      true,
    );
  } catch (err) {
    page(
      'The connection could not be completed',
      `<p>${escapeText(err instanceof Error ? err.message : String(err))}</p>`,
      false,
    );
  }
});

export const disconnectGoogleOAuth = catchAsync(async (_req: Request, res: Response) => {
  await forgetRefreshToken();
  googleDriveClient.resetAuth();
  clearLibraryFolderCache();
  res.status(200).json({ success: true, data: { authorized: false } });
});

/**
 * A short-lived access token for the Google Picker, and nothing else.
 *
 * With the drive.file scope the application can only touch what it
 * created -- so the folder the studio made by hand has to be handed to
 * it once, and the Picker is the only way Google provides. The Picker
 * runs in the browser and needs a token there; this mints one from the
 * stored refresh token, for the owner alone. The refresh token itself
 * never leaves the server.
 */
export const getGooglePickerToken = catchAsync(async (_req: Request, res: Response) => {
  const client = await getOAuthClient();
  try {
    const { token, res: tokenRes } = await client.getAccessToken();
    if (!token) throw AppError.badRequest('Google returned no access token.');
    const expiresIn = (tokenRes?.data as { expires_in?: number } | undefined)?.expires_in ?? 3600;

    // WITHOUT THIS THE PICKER GRANTS NOTHING. See pickerAppId: it is
    // required for the drive.file scope, and its absence is silent --
    // the folder is picked, the id comes back, and the server is then
    // refused with a 404 it cannot tell from a typo.
    const appId = pickerAppId();

    res.status(200).json({
      success: true,
      data: {
        accessToken: token,
        expiresIn,
        apiKey: config.google.pickerApiKey,
        appId,
        appIdProblem: appId
          ? ''
          : 'GOOGLE_OAUTH_CLIENT_ID does not begin with a project number, so the Picker cannot '
            + 'be told which app to grant access to. A Google OAuth client id looks like '
            + '"123456789012-abc.apps.googleusercontent.com"; check the value.',
        folderId: driveFolderIdFrom(config.google.driveLibraryFolder),
      },
    });
  } catch (err) {
    throw AppError.badRequest(`Google Drive could not be reached: ${describeOAuthError(err)}`);
  }
});

/**
 * THE REAL PROOF, runnable in production by the person who has to
 * trust it: the folder, the Theme/Room tree, one actual upload, a
 * public link, and the upload removed again.
 *
 * Every step reports for itself, because "it failed" was exactly the
 * answer that cost the studio an evening -- and the test leaves behind
 * only the two folders the library would have created anyway.
 */
export const runDriveSelfTest = catchAsync(async (_req: Request, res: Response) => {
  /**
   * `informational` steps are reported but do not decide the verdict.
   * Knowing which Google account the server is cannot be had on every
   * scope, and a deployment that uploads perfectly well should not be
   * told it failed because Drive declined to introduce itself.
   */
  const steps: { step: string; ok: boolean; detail: string; informational?: boolean }[] = [];
  const record = async (step: string, fn: () => Promise<string>, informational = false) => {
    try {
      steps.push({ step, ok: true, detail: await fn(), informational });
      return true;
    } catch (err) {
      steps.push({
        step,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        informational,
      });
      return false;
    }
  };

  // A real 1x1 PNG -- the upload path checks the bytes, not the name.
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );

  // WHO THE SERVER IS, asked of Google rather than inferred. A folder
  // shared with one account and a request made by another look
  // identical from the outside; this is the step that tells them apart.
  await record('The Google account this server is acting as', async () => {
    const who = await googleDriveClient.whoAmI();
    if (!who) return 'Drive did not say \u2014 the credential cannot read about.get.';
    return `${who.email}${who.name ? ` (${who.name})` : ''}`;
  }, true);

  const folder = await describeLibraryFolder();
  steps.push({
    step: 'The library’s Drive folder',
    ok: folder.ok,
    detail: folder.ok ? `${folder.name} (${folder.folderId})` : folder.reason,
  });

  let themeId = '';
  let roomId = '';
  let fileId = '';

  if (folder.ok) {
    await record('Theme folder "British"', async () => {
      const made = await googleDriveClient.getOrCreateFolder('British', folder.folderId);
      themeId = made.id;
      return made.id;
    });
  }
  if (themeId) {
    await record('Room folder "Bathroom"', async () => {
      const made = await googleDriveClient.getOrCreateFolder('Bathroom', themeId);
      roomId = made.id;
      return made.id;
    });
  }
  if (roomId) {
    await record('Uploading a test picture', async () => {
      const file = await googleDriveClient.uploadFile({
        name: `devyora-connection-test-${Date.now()}.png`,
        mimeType: 'image/png',
        content: PNG,
        parentFolderId: roomId,
      });
      fileId = file.id;
      return file.id;
    });
  }
  if (fileId) {
    // DRIVE ASKED AGAIN, INDEPENDENTLY. The upload's own 200 is the
    // request being accepted; this is the file being found afterwards,
    // in the folder it was supposed to land in. They are not the same
    // claim, and only the second one is worth reporting as proof.
    await record('Finding it again in that folder', async () => {
      const found = await googleDriveClient.describeFile(fileId);
      if (!found) throw new Error(`Drive does not return a file with id ${fileId}.`);
      if (!found.parents.includes(roomId)) {
        throw new Error(
          `The file exists (${found.id}) but its parent is ${found.parents.join(', ') || '(none)'}, `
          + `not the Bathroom folder ${roomId}.`,
        );
      }
      return `${found.name} \u2014 id ${found.id}, inside ${roomId}`;
    });

    await record('Making it readable by link', () => googleDriveClient.generatePublicLink(fileId));

    // THE FOUR WAYS THIS STEP CAN FAIL ARE NOT THE SAME FAILURE. The
    // permission call above can succeed and the file still not be
    // fetchable -- a Workspace or account policy can refuse
    // link-sharing after the fact. The only way to tell is to fetch it
    // the way the Python visualization service will: no credentials.
    await record('Fetching it with no credentials, as the generator does', async () => {
      const url = toDriveDownloadUrl(fileId);
      // Not annotated: `Response` in this file is Express's.
      const res = await fetch(url, { redirect: 'follow' }).catch((err: unknown) => {
        throw new Error(
          `The link could not be fetched at all (${err instanceof Error ? err.message : String(err)}). `
          + 'That is a network failure from this deployment, not a Drive permission problem.',
        );
      });
      if (!res.ok) {
        throw new Error(
          `Drive answered ${res.status} to an anonymous fetch of ${url}. The file uploaded and the `
          + 'permission was accepted, so this is a sharing restriction on the account rather than '
          + 'an upload failure \u2014 generated scenes would not be able to read it.',
        );
      }
      const type = res.headers.get('content-type') || '';
      return `${res.status} ${type}`;
    });

    await record('Removing the test picture again', async () => {
      await googleDriveClient.deleteFile(fileId);
      return 'deleted';
    });

    // ...and gone means gone: a delete that reports success and
    // leaves the file behind would quietly litter the studio's folder
    // every time this test is run.
    await record('Confirming it is gone', async () => {
      const stillThere = await googleDriveClient.describeFile(fileId);
      if (stillThere) throw new Error(`The test picture ${fileId} is still in Drive.`);
      return 'the folder is as it was';
    });
  }

  res.status(200).json({
    success: true,
    data: {
      ok: steps.every((s) => s.ok || s.informational),
      authMode: await googleDriveClient.authMode(),
      steps,
    },
  });
});

/** Minimal escaping for the few values echoed into the callback page. */
function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string
  ));
}

export const testDriveConnection = catchAsync(async (_req: Request, res: Response) => {
  const result = await googleDriveClient.testConnection();
  res.status(200).json({ success: true, data: result });
});

export const getPythonAiStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      baseUrl: config.python.aiBaseUrl,
    },
  });
});

export const testPythonAiConnection = catchAsync(async (_req: Request, res: Response) => {
  // Same "always 200" reasoning as testGeminiConnection/testDriveConnection —
  // an unreachable service is a real, expected result the frontend needs to
  // read from data.ok, not an HTTP error that gets swallowed by generic
  // error handling.
  const startedAt = Date.now();
  try {
    const health = await checkPythonAIHealth();
    res.status(200).json({ success: true, data: { ok: true, latencyMs: Date.now() - startedAt, health } });
  } catch (err) {
    res.status(200).json({
      success: true,
      data: {
        ok: false,
        message: err instanceof Error ? err.message : 'Could not reach the Python AI service.',
      },
    });
  }
});
