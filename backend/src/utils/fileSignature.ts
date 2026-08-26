import fs from 'fs';

/**
 * Verifies a file's real format by its magic bytes rather than trusting
 * the client-supplied MIME type header, which anyone can set to whatever
 * they like regardless of the file's actual content. multer's fileFilter
 * already rejects wrong-*declared*-type uploads; this catches the case
 * where someone renames/relabels a malicious file (e.g. an HTML/SVG file
 * with embedded script, or an executable) to look like a PDF or image.
 */

const SIGNATURES = {
  PDF: [0x25, 0x50, 0x44, 0x46], // %PDF
  JPEG: [0xff, 0xd8, 0xff],
  PNG: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  RIFF: [0x52, 0x49, 0x46, 0x46], // "RIFF" — WebP container; the real WEBP marker at offset 8 is checked separately
};

function matchesSignature(buffer: Buffer, bytes: number[], offset = 0): boolean {
  if (buffer.length < offset + bytes.length) return false;
  return bytes.every((byte, i) => buffer[offset + i] === byte);
}

function readHeader(filePath: string, length = 16): Buffer {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    fs.closeSync(fd);
  }
}

/** True if the file at filePath genuinely starts with PDF magic bytes (%PDF), regardless of what its declared MIME type or filename extension claimed. */
export function isRealPdf(filePath: string): boolean {
  const header = readHeader(filePath, 5);
  return matchesSignature(header, SIGNATURES.PDF);
}

/** True if the file at filePath genuinely is a JPEG, PNG, or WebP by magic bytes — same reasoning as isRealPdf. */
export function isRealImage(filePath: string): boolean {
  const header = readHeader(filePath, 16);
  if (matchesSignature(header, SIGNATURES.JPEG)) return true;
  if (matchesSignature(header, SIGNATURES.PNG)) return true;
  // WebP: "RIFF" at 0-3, then 4 bytes of file size, then "WEBP" at 8-11
  if (matchesSignature(header, SIGNATURES.RIFF) && header.length >= 12) {
    return header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50; // "WEBP"
  }
  return false;
}
