import mongoose from 'mongoose';

export function detectAllowedUploadType(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === '%PDF-') {
    return 'application/pdf';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

/** Decodes a base64 (optionally data-URL) payload; returns null if invalid or too large. */
export function decodeBase64Upload(value: unknown, maxBytes: number): Buffer | null {
  if (typeof value !== 'string' || !value) return null;
  const raw = value.replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(raw)) return null;
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length === 0 || buffer.length > maxBytes) return null;
  return buffer;
}

export function getBucket(bucketName: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database is not connected.');
  return new mongoose.mongo.GridFSBucket(db, { bucketName });
}
