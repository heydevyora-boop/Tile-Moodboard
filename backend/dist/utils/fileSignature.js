"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRealPdf = isRealPdf;
exports.isRealImage = isRealImage;
const fs_1 = __importDefault(require("fs"));
const SIGNATURES = {
    PDF: [0x25, 0x50, 0x44, 0x46],
    JPEG: [0xff, 0xd8, 0xff],
    PNG: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    RIFF: [0x52, 0x49, 0x46, 0x46],
};
function matchesSignature(buffer, bytes, offset = 0) {
    if (buffer.length < offset + bytes.length)
        return false;
    return bytes.every((byte, i) => buffer[offset + i] === byte);
}
function readHeader(filePath, length = 16) {
    const fd = fs_1.default.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        const bytesRead = fs_1.default.readSync(fd, buffer, 0, length, 0);
        return buffer.subarray(0, bytesRead);
    }
    finally {
        fs_1.default.closeSync(fd);
    }
}
function isRealPdf(filePath) {
    const header = readHeader(filePath, 5);
    return matchesSignature(header, SIGNATURES.PDF);
}
function isRealImage(filePath) {
    const header = readHeader(filePath, 16);
    if (matchesSignature(header, SIGNATURES.JPEG))
        return true;
    if (matchesSignature(header, SIGNATURES.PNG))
        return true;
    if (matchesSignature(header, SIGNATURES.RIFF) && header.length >= 12) {
        return header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50;
    }
    return false;
}
//# sourceMappingURL=fileSignature.js.map