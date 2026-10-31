import { z } from 'zod';
import { config } from '@config/index';

/**
 * WHO IS LOGGING IN.
 *
 * Normally an email address, which is what the User table is keyed on.
 *
 * A temporary development login is a plain username instead, so this
 * also accepts that ONE configured string, matched exactly and
 * case-insensitively. config.devLogin is null in production and null
 * when no development login is configured, so on a public deployment
 * this is the email-only rule it has always been.
 *
 * This decides what may be TYPED. It is not an authentication step:
 * whatever arrives still has to match a real account and its stored
 * password hash.
 */
const identifierSchema = z
  .string()
  .trim()
  .refine(
    (value) => {
      if (z.string().email().safeParse(value).success) return true;
      const dev = config.devLogin;
      return Boolean(dev) && value.toLowerCase() === dev!.username;
    },
    { message: 'Enter a valid email address' },
  );

const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number');

// The password rule here is `min(1)` and always has been: the length
// and complexity rules below apply to SETTING a password, not to
// typing one at the gate. A short development password therefore needs
// no change here, and the rules that protect real passwords are left
// exactly as they are.
export const loginSchema = z.object({
  email: identifierSchema,
  password: z.string().min(1, 'Password is required'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Enter a valid email address'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  newPassword: passwordSchema,
});

export const refreshSchema = z.object({
  // Optional in the body because the primary path is reading it from the httpOnly cookie
  refreshToken: z.string().optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
