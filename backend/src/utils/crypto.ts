import crypto from 'crypto';

/**
 * Generates a cryptographically random opaque token (used for refresh
 * tokens and password reset tokens — deliberately NOT a JWT, so it carries
 * no information on its own and is meaningless without a DB lookup).
 */
export function generateOpaqueToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Hashes an opaque token with HMAC-SHA256 using the given secret as a
 * pepper. We store only this hash in the DB — never the raw token — so a
 * database leak alone doesn't let an attacker replay or look up valid
 * sessions/reset links without also having the app secret.
 */
export function hashToken(rawToken: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(rawToken).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// Reversible encryption — for secrets that must be retrieved in plaintext
// to actually be used (stored API keys), unlike passwords/tokens above
// which only ever need to be verified, never read back. AES-256-GCM: the
// auth tag means tampering with ciphertext is detected, not just ignored.
// ─────────────────────────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

/** Encrypts plaintext with a 32-byte key (derived from the app's ENCRYPTION_KEY). Output packs iv:authTag:ciphertext, all hex, so decrypt() is self-contained. */
export function encryptSecret(plaintext: string, key32: Buffer): string {
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key32, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}

export function decryptSecret(packed: string, key32: Buffer): string {
  const [ivHex, authTagHex, ciphertextHex] = packed.split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted value — expected iv:authTag:ciphertext');
  }
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key32, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
  return plaintext.toString('utf8');
}

/** Derives a stable 32-byte key from the configured secret — SHA-256 conveniently always outputs exactly 32 bytes, which is what AES-256 requires. */
export function deriveEncryptionKey(secret: string): Buffer {
  return crypto.createHash('sha256').update(secret).digest();
}
