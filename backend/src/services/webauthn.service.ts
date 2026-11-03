/**
 * Face ID and fingerprint sign-in, as passkeys.
 *
 * WHAT THIS IS AND IS NOT. It is a second way IN to the SAME session the
 * password login issues -- the very same access token, the very same
 * refresh cookie, the same thirty days. It is not a second kind of
 * session, and nothing here can create one: every successful assertion
 * ends in auth.service's own issueTokenPair.
 *
 * A device can only be enrolled from behind a normal email + password
 * sign-in. A passkey is therefore always something the account holder
 * added on purpose, never a way to acquire an account.
 *
 * All the cryptography is @simplewebauthn/server's. Nothing in this file
 * verifies a signature, parses CBOR or touches a key.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { prisma } from '@db/connection';
import { config } from '@config/index';
import { AppError } from '@utils/AppError';

/** How long a challenge is good for. Short, because it is a one-shot. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Error codes the client is written against. They are part of the
 * contract with login.html, so they are named here rather than spelled
 * out at each throw site.
 */
export const PASSKEY_STALE = 'PASSKEY_STALE';
export const PASSKEY_UNKNOWN = 'PASSKEY_UNKNOWN';

/**
 * A 401 carrying a code the login page branches on.
 *
 * AppError.unauthorized() takes no details, and the error handler puts
 * `details` in the response body as `errors` -- so the error is built
 * directly rather than widening a helper every route shares.
 */
function passkeyRefused(message: string, code: string): AppError {
  return new AppError(message, 401, { code });
}

// ─────────────────────────────────────────────────────────────────────────
// THE RELYING PARTY IS WHATEVER HOST ASKED
//
// A passkey is bound to one hostname. This deployment has three kinds of
// them -- the production domain, a fresh URL for every Vercel preview,
// and localhost -- and hard-coding any one of them breaks the other two.
//
// So the RP ID is read from the request's own Origin. That is safe
// because the browser sets Origin and a page cannot forge it, and
// because the same Origin is handed to the verifier below as the one the
// assertion must have been signed for.
//
// https is required, except on localhost, which is exactly where
// WebAuthn itself draws the line.
// ─────────────────────────────────────────────────────────────────────────

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function relyingParty(originHeader: string | undefined): { rpID: string; origin: string } {
  const raw = String(originHeader ?? '').trim();
  if (!raw) {
    throw AppError.badRequest('This request carried no Origin, so there is no site to sign in to.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw AppError.badRequest('This request carried an Origin that is not a URL.');
  }

  const host = url.hostname;
  const local = LOCAL_HOSTS.has(host);
  if (url.protocol !== 'https:' && !local) {
    throw AppError.badRequest('Face ID and fingerprint sign-in need a secure (https) connection.');
  }

  return { rpID: host, origin: url.origin };
}

// ─────────────────────────────────────────────────────────────────────────
// CHALLENGES: SIGNED, SHORT-LIVED, AND SPENT ONCE
//
// The challenge carries its own expiry and a signature over it, so a
// forged or stale one is refused without a lookup. That alone does not
// stop a REPLAY -- a captured sign-in could be sent twice inside the five
// minutes -- so every challenge that verifies is written down as spent
// first, and a second use of the same one is refused.
//
// Issuing stays stateless; only spending costs a row. Rows past their
// expiry are swept as we go, because this deployment has no scheduler.
// ─────────────────────────────────────────────────────────────────────────

function challengeSecret(): string {
  return config.auth.jwtSecret;
}

function sign(payload: string): string {
  return createHmac('sha256', challengeSecret()).update(payload).digest('base64url');
}

/** `<nonce>.<expiry>.<signature>`, which is what the authenticator signs. */
export function issueChallenge(now: Date = new Date()): string {
  const nonce = randomBytes(24).toString('base64url');
  const expiry = String(now.getTime() + CHALLENGE_TTL_MS);
  const payload = `${nonce}.${expiry}`;
  return `${payload}.${sign(payload)}`;
}

function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when this challenge is ours, unexpired, and had not been used.
 *
 * Marks it used in the same call: there is no point at which a caller
 * holds a verified-but-unspent challenge.
 */
export async function spendChallenge(challenge: string, now: Date = new Date()): Promise<boolean> {
  const parts = String(challenge ?? '').split('.');
  if (parts.length !== 3) return false;

  const [nonce, expiry, signature] = parts;
  if (!signatureMatches(sign(`${nonce}.${expiry}`), signature)) return false;

  const expiresAt = Number(expiry);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) return false;

  // The unique index is what actually guarantees single use -- two
  // requests racing cannot both insert. The lookup in front of it is
  // only so the ordinary refusal does not go through the ORM's error
  // path and land in the log as a database error: a refused replay is a
  // security event worth seeing, not a fault worth a stack trace.
  const spent = await prisma.webAuthnChallenge.findUnique({
    where: { challenge },
    select: { id: true },
  });
  if (spent) return false;

  try {
    await prisma.webAuthnChallenge.create({
      data: { challenge, usedAt: now, expiresAt: new Date(expiresAt) },
    });
  } catch {
    return false;
  }

  await prisma.webAuthnChallenge
    .deleteMany({ where: { expiresAt: { lt: now } } })
    .catch(() => undefined);

  return true;
}

/**
 * The challenge the browser will echo back, as SimpleWebAuthn renders it.
 *
 * generateXOptions() takes our ASCII payload and base64url-encodes its
 * bytes for the client, so that encoded form -- not the payload -- is
 * what comes back in clientDataJSON and what expectedChallenge compares.
 */
function fromReturned(received: string): string {
  return Buffer.from(received, 'base64url').toString('utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// A PASSKEY DOES NOT OUTLIVE THE PASSWORD IT WAS ADDED BEHIND
//
// Enrolment happens behind a password sign-in, so a passkey is a
// standing claim that whoever holds this device knew the password then.
// If the password changes -- a reset after a lost phone is the case that
// matters -- that claim is stale and the key must stop working.
//
// The tag is a keyed digest of the stored password hash, truncated. It
// is not the hash and cannot be turned back into one, and it changes
// whenever the hash does, which is the only property needed.
// ─────────────────────────────────────────────────────────────────────────

export function passwordTag(passwordHash: string): string {
  return createHmac('sha256', challengeSecret()).update(passwordHash).digest('base64url').slice(0, 24);
}

// ─────────────────────────────────────────────────────────────────────────
// REGISTRATION
// ─────────────────────────────────────────────────────────────────────────

export async function registrationOptions(userId: string, originHeader: string | undefined) {
  const { rpID } = relyingParty(originHeader);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, isActive: true },
  });
  if (!user || !user.isActive) throw AppError.unauthorized('This account cannot enrol a device.');

  // Only the credentials for THIS host: a key made on a preview URL is a
  // different relying party and excluding it here would be meaningless.
  const existing = await prisma.webAuthnCredential.findMany({
    where: { userId, rpId: rpID },
    select: { credentialId: true, transports: true },
  });

  const challenge = issueChallenge();

  const options = await generateRegistrationOptions({
    rpName: 'De’vyora Studio',
    rpID,
    userName: user.email,
    userDisplayName: user.name,
    userID: Buffer.from(user.id, 'utf8'),
    challenge,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      transports: c.transports as never,
    })),
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      userVerification: 'required',
      residentKey: 'preferred',
    },
  });

  return options;
}

export async function registerCredential(
  userId: string,
  originHeader: string | undefined,
  response: RegistrationResponseJSON,
  label?: string,
) {
  const { rpID, origin } = relyingParty(originHeader);

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, name: true, passwordHash: true, isActive: true },
  });
  if (!user || !user.isActive) throw AppError.unauthorized('This account cannot enrol a device.');

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: (received) => spendChallenge(fromReturned(received)),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (error) {
    throw AppError.badRequest(
      `This device could not be enrolled: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }

  if (!verification.verified || !verification.registrationInfo) {
    throw AppError.badRequest('This device could not be enrolled.');
  }

  const { credential } = verification.registrationInfo;

  // The same key offered twice is not an error worth failing on -- the
  // browser can retry -- but it must not become two rows.
  const saved = await prisma.webAuthnCredential.upsert({
    where: { credentialId: credential.id },
    update: {
      counter: BigInt(credential.counter),
      transports: credential.transports ?? [],
      passwordTag: passwordTag(user.passwordHash),
    },
    create: {
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: BigInt(credential.counter),
      transports: credential.transports ?? [],
      rpId: rpID,
      passwordTag: passwordTag(user.passwordHash),
      label: label?.slice(0, 80) || null,
    },
    select: { id: true, createdAt: true },
  });

  return { credentialId: saved.id, email: user.email, name: user.name };
}

// ─────────────────────────────────────────────────────────────────────────
// SIGNING IN
// ─────────────────────────────────────────────────────────────────────────

/**
 * With an email, the keys that account holds on this host. Without one,
 * none at all -- which is what asks the browser for any discoverable
 * passkey it has for this site, so a key synced from another device can
 * sign in on a phone this server has never seen.
 */
export async function authenticationOptions(
  email: string | undefined,
  originHeader: string | undefined,
) {
  const { rpID } = relyingParty(originHeader);
  const challenge = issueChallenge();

  const typed = String(email ?? '').trim().toLowerCase();
  const allowCredentials = typed
    ? (
      await prisma.webAuthnCredential.findMany({
        where: { rpId: rpID, user: { email: typed, isActive: true } },
        select: { credentialId: true, transports: true },
      })
    ).map((c) => ({ id: c.credentialId, transports: c.transports as never }))
    : undefined;

  return generateAuthenticationOptions({
    rpID,
    challenge,
    userVerification: 'required',
    ...(allowCredentials && allowCredentials.length ? { allowCredentials } : {}),
  });
}

export interface PasskeyUser {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  isActive: boolean;
  lastLoginAt: Date | null;
  role: { name: string; permissions: string[] };
}

/**
 * Verifies the assertion and returns the user it belongs to.
 *
 * Issuing the session is deliberately NOT done here: the caller hands
 * this user to auth.service, which issues exactly what a password login
 * issues. One place mints sessions, and it is not this file.
 */
export async function verifyPasskey(
  originHeader: string | undefined,
  response: AuthenticationResponseJSON,
): Promise<PasskeyUser> {
  const { rpID, origin } = relyingParty(originHeader);

  const stored = await prisma.webAuthnCredential.findUnique({
    where: { credentialId: response.id },
    include: { user: { include: { role: true } } },
  });

  // Unknown key, a key for another host, or an account that has since
  // been deleted -- the cascade takes the row with the user, so a
  // deleted account simply has none. One message for all three: a client
  // must not learn which.
  if (!stored || stored.rpId !== rpID || !stored.user || !stored.user.isActive) {
    throw passkeyRefused(
      'This device is not set up for sign-in here. Sign in with your password to set it up again.',
      PASSKEY_UNKNOWN,
    );
  }

  const currentTag = passwordTag(stored.user.passwordHash);
  if (stored.passwordTag !== currentTag) {
    // The password has changed since this key was added, which makes
    // EVERY key enrolled behind the old password stale -- not just the
    // one on this device. A reset after a lost phone has to kill the
    // lost phone's key too, and that key will never be presented here.
    //
    // Clearing them means the next password sign-in offers enrolment
    // again rather than failing a second time.
    await prisma.webAuthnCredential
      .deleteMany({ where: { userId: stored.userId, passwordTag: { not: currentTag } } })
      .catch(() => undefined);
    throw passkeyRefused(
      'Your password has changed since this device was set up. Sign in with your password to set it up again.',
      PASSKEY_STALE,
    );
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: (received) => spendChallenge(fromReturned(received)),
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
      credential: {
        id: stored.credentialId,
        publicKey: new Uint8Array(Buffer.from(stored.publicKey, 'base64url')),
        counter: Number(stored.counter),
        transports: stored.transports as never,
      },
    });
  } catch {
    throw AppError.unauthorized('That did not match. Try again, or use your email and password.');
  }

  if (!verification.verified) {
    throw AppError.unauthorized('That did not match. Try again, or use your email and password.');
  }

  await prisma.webAuthnCredential.update({
    where: { id: stored.id },
    data: {
      counter: BigInt(verification.authenticationInfo.newCounter),
      lastUsedAt: new Date(),
    },
  });

  return stored.user as PasskeyUser;
}

/** Whether this account has a passkey on this host, for the login page. */
export async function hasCredentials(
  email: string | undefined,
  originHeader: string | undefined,
): Promise<boolean> {
  const typed = String(email ?? '').trim().toLowerCase();
  if (!typed) return false;
  const { rpID } = relyingParty(originHeader);
  const count = await prisma.webAuthnCredential.count({
    where: { rpId: rpID, user: { email: typed, isActive: true } },
  });
  return count > 0;
}
