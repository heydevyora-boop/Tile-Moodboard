import 'tsconfig-paths/register';
import { encryptSecret, decryptSecret, deriveEncryptionKey } from '../src/utils/crypto';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
    fail++;
  }
}

function main() {
  const key = deriveEncryptionKey('test-secret-for-api-keys');
  const otherKey = deriveEncryptionKey('a-completely-different-secret');

  check('1. deriveEncryptionKey produces exactly 32 bytes (required for AES-256)', key.length === 32, key.length);

  const plaintext = 'AIzaSyD-fake-gemini-key-for-testing-1234567890';
  const encrypted = encryptSecret(plaintext, key);

  check('2. Encrypted value is not the plaintext', encrypted !== plaintext);
  check('3. Encrypted value does not contain the plaintext as a substring', !encrypted.includes(plaintext));
  check('4. Encrypted value has the expected iv:authTag:ciphertext shape', encrypted.split(':').length === 3, encrypted);

  const decrypted = decryptSecret(encrypted, key);
  check('5. Round-trip decrypt recovers the exact original plaintext', decrypted === plaintext, decrypted);

  const encryptedAgain = encryptSecret(plaintext, key);
  check('6. Encrypting the same plaintext twice produces DIFFERENT ciphertext (random IV -- no pattern leakage)', encryptedAgain !== encrypted, { first: encrypted, second: encryptedAgain });
  check('6b. ...but both still decrypt to the same plaintext', decryptSecret(encryptedAgain, key) === plaintext);

  let threwOnWrongKey = false;
  try {
    decryptSecret(encrypted, otherKey);
  } catch {
    threwOnWrongKey = true;
  }
  check('7. Decrypting with the WRONG key throws (auth tag mismatch), not silently returns garbage', threwOnWrongKey);

  let threwOnTampered = false;
  try {
    const parts = encrypted.split(':');
    const iv = parts[0];
    const authTag = parts[1];
    const ciphertext = parts[2];
    const tampered = `${iv}:${authTag}:${ciphertext.slice(0, -2)}ff`;
    decryptSecret(tampered, key);
  } catch {
    threwOnTampered = true;
  }
  check('8. Decrypting TAMPERED ciphertext throws (GCM auth tag catches modification)', threwOnTampered);

  let threwOnMalformed = false;
  try {
    decryptSecret('not-the-right-format-at-all', key);
  } catch {
    threwOnMalformed = true;
  }
  check('9. Decrypting a malformed (non iv:tag:ciphertext) string throws cleanly rather than crashing oddly', threwOnMalformed);

  const longSecret = JSON.stringify({ type: 'service_account', private_key: 'x'.repeat(1600), client_email: 'test@test.iam.gserviceaccount.com' });
  const encryptedLong = encryptSecret(longSecret, key);
  check('10. Long secrets (e.g. a service account JSON key) round-trip correctly too', decryptSecret(encryptedLong, key) === longSecret);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
