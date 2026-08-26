import bcrypt from 'bcryptjs';
import { config } from '@config/index';

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, config.auth.bcryptSaltRounds);
}

export function comparePassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
