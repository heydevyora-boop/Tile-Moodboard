import jwt, { JwtPayload, SignOptions } from 'jsonwebtoken';
import { config } from '@config/index';

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  role: string;
  permissions: string[];
}

export function signAccessToken(payload: AccessTokenPayload): string {
  const options: SignOptions = { expiresIn: config.auth.jwtExpiresIn as SignOptions['expiresIn'] };
  return jwt.sign(payload, config.auth.jwtSecret, options);
}

/**
 * Verifies and decodes an access token. Throws (jsonwebtoken's own
 * TokenExpiredError / JsonWebTokenError) on failure — the global error
 * handler already knows how to turn those into clean 401 responses.
 */
export function verifyAccessToken(token: string): AccessTokenPayload {
  const decoded = jwt.verify(token, config.auth.jwtSecret) as JwtPayload & AccessTokenPayload;
  return {
    sub: decoded.sub,
    email: decoded.email,
    role: decoded.role,
    permissions: decoded.permissions ?? [],
  };
}
