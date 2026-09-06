"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateOpaqueToken = generateOpaqueToken;
exports.hashToken = hashToken;
exports.encryptSecret = encryptSecret;
exports.decryptSecret = decryptSecret;
exports.deriveEncryptionKey = deriveEncryptionKey;
const crypto_1 = __importDefault(require("crypto"));
function generateOpaqueToken(bytes = 32) {
    return crypto_1.default.randomBytes(bytes).toString('hex');
}
function hashToken(rawToken, secret) {
    return crypto_1.default.createHmac('sha256', secret).update(rawToken).digest('hex');
}
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
function encryptSecret(plaintext, key32) {
    const iv = crypto_1.default.randomBytes(12);
    const cipher = crypto_1.default.createCipheriv(ENCRYPTION_ALGORITHM, key32, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${ciphertext.toString('hex')}`;
}
function decryptSecret(packed, key32) {
    const [ivHex, authTagHex, ciphertextHex] = packed.split(':');
    if (!ivHex || !authTagHex || !ciphertextHex) {
        throw new Error('Malformed encrypted value — expected iv:authTag:ciphertext');
    }
    const decipher = crypto_1.default.createDecipheriv(ENCRYPTION_ALGORITHM, key32, Buffer.from(ivHex, 'hex'));
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextHex, 'hex')), decipher.final()]);
    return plaintext.toString('utf8');
}
function deriveEncryptionKey(secret) {
    return crypto_1.default.createHash('sha256').update(secret).digest();
}
//# sourceMappingURL=crypto.js.map