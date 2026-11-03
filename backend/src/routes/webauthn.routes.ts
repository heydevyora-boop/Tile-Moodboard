/**
 * Face ID / fingerprint sign-in.
 *
 *   POST /auth/passkey/register-options   session required
 *   POST /auth/passkey/register           session required
 *   POST /auth/passkey/login-options      open
 *   POST /auth/passkey/login              open
 *   GET  /auth/passkey/status             open
 *
 * The two enrolment steps sit behind `authenticate`, so a device can
 * only ever be added by someone who is already signed in -- which, on
 * this site, means someone who just typed the password. A challenge is
 * not a session and cannot be traded for one: the only thing that issues
 * a session here is auth.service.sessionFor, after a verified assertion.
 */

import { Router, Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { AppError } from '@utils/AppError';
import { authenticate } from '@middlewares/auth';
import { config } from '@config/index';
import { parseDurationMs } from '@utils/duration';
import * as webauthn from '@services/webauthn.service';
import * as authService from '@services/auth.service';
import type { CookieOptions } from 'express';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';

const router = Router();

// The same cookie the password login sets, written the same way. It is
// duplicated from auth.controller rather than exported from it because
// that module owns the password flow's request shapes; the options
// themselves are the contract, and the test suite compares them.
function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: config.isProd ? 'strict' : 'lax',
    maxAge: parseDurationMs(config.auth.jwtRefreshExpiresIn),
    path: '/api/v1/auth',
  };
}

function origin(req: Request): string | undefined {
  const header = req.get('origin');
  if (header) return header;
  // A same-origin POST from some browsers omits Origin; the Referer
  // still names the page that made it, which is the same thing for this
  // purpose. Neither can be set by page script.
  const referer = req.get('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

router.post(
  '/passkey/register-options',
  authenticate,
  catchAsync(async (req: Request, res: Response) => {
    const options = await webauthn.registrationOptions(req.user!.id, origin(req));
    res.status(200).json({ success: true, data: { options } });
  }),
);

router.post(
  '/passkey/register',
  authenticate,
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as { response?: RegistrationResponseJSON; label?: string };
    if (!body?.response) throw AppError.badRequest('No device response was sent.');

    const saved = await webauthn.registerCredential(
      req.user!.id,
      origin(req),
      body.response,
      body.label,
    );
    res.status(200).json({ success: true, data: saved });
  }),
);

router.post(
  '/passkey/login-options',
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as { email?: string };
    const options = await webauthn.authenticationOptions(body?.email, origin(req));
    res.status(200).json({ success: true, data: { options } });
  }),
);

router.post(
  '/passkey/login',
  catchAsync(async (req: Request, res: Response) => {
    const body = req.body as { response?: AuthenticationResponseJSON };
    if (!body?.response) throw AppError.badRequest('No device response was sent.');

    const user = await webauthn.verifyPasskey(origin(req), body.response);
    const session = await authService.sessionFor(user, req, 'passkey');

    res.cookie(config.auth.refreshCookieName, session.refreshToken, refreshCookieOptions());
    res.status(200).json({
      success: true,
      data: {
        user: session.user,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      },
    });
  }),
);

/** Whether this account already has a key here. Used by the login page. */
router.get(
  '/passkey/status',
  catchAsync(async (req: Request, res: Response) => {
    const email = typeof req.query.email === 'string' ? req.query.email : undefined;
    const enrolled = await webauthn.hasCredentials(email, origin(req));
    res.status(200).json({ success: true, data: { enrolled } });
  }),
);

export default router;
