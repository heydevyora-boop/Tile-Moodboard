import { CookieOptions, Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { config } from '@config/index';
import { parseDurationMs } from '@utils/duration';
import * as authService from '@services/auth.service';
import { LoginInput, ForgotPasswordInput, ResetPasswordInput } from '@validators/auth.validators';

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.isProd,
    // 'lax' works for same-site setups (including different localhost ports
    // during dev — they share the same "site"). If the frontend and backend
    // end up on genuinely different domains in production (not subdomains
    // behind one reverse proxy), this needs to become 'none' + secure:true,
    // or the browser won't send the cookie on cross-site requests at all.
    sameSite: config.isProd ? 'strict' : 'lax',
    maxAge: parseDurationMs(config.auth.jwtRefreshExpiresIn),
    path: '/api/v1/auth', // only sent to auth endpoints (refresh/logout), not the whole API
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(config.auth.refreshCookieName, token, refreshCookieOptions());
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(config.auth.refreshCookieName, { ...refreshCookieOptions(), maxAge: undefined });
}

function readRefreshCookie(req: Request): string | undefined {
  const cookies = req.cookies as Record<string, string> | undefined;
  return cookies?.[config.auth.refreshCookieName] ?? (req.body as { refreshToken?: string })?.refreshToken;
}

export const login = catchAsync(async (req: Request, res: Response) => {
  const { email, password } = req.body as LoginInput;
  const { user, accessToken, refreshToken } = await authService.login(email, password, req);

  setRefreshCookie(res, refreshToken);
  res.status(200).json({ success: true, data: { user, accessToken, refreshToken } });
});

export const logout = catchAsync(async (req: Request, res: Response) => {
  const rawRefreshToken = readRefreshCookie(req);
  await authService.logout(rawRefreshToken, req.user?.id, req);

  clearRefreshCookie(res);
  res.status(200).json({ success: true, message: 'Logged out' });
});

export const refresh = catchAsync(async (req: Request, res: Response) => {
  const rawRefreshToken = readRefreshCookie(req);
  const { user, accessToken, refreshToken } = await authService.refresh(rawRefreshToken, req);

  setRefreshCookie(res, refreshToken);
  res.status(200).json({ success: true, data: { user, accessToken, refreshToken } });
});

export const forgotPassword = catchAsync(async (req: Request, res: Response) => {
  const { email } = req.body as ForgotPasswordInput;
  await authService.forgotPassword(email, req);

  // Always the same response, whether or not the account exists.
  res.status(200).json({
    success: true,
    message: 'If an account exists for that email, a password reset link has been sent.',
  });
});

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  const { token, newPassword } = req.body as ResetPasswordInput;
  await authService.resetPassword(token, newPassword, req);

  res.status(200).json({ success: true, message: 'Password has been reset. Please log in again.' });
});

export const me = catchAsync(async (req: Request, res: Response) => {
  res.status(200).json({ success: true, data: { user: req.user } });
});
