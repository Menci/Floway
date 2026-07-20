// crc-32 ships pure CommonJS without an `exports` map. Cloudflare's bundler
// does CJS named-import interop, but raw Node ESM rejects its named export.
import crc32Mod from 'crc-32';

const { buf: crc32 } = crc32Mod;
const RESPONSE_ID_PATTERN = /^resp_([A-Za-z0-9_-]{6})_([A-Za-z0-9_-]{22})$/;

// A response from Floway can span several upstream calls behind hosted tools,
// so the source boundary owns one envelope id independently of output items.
export const createResponsesResponseId = (): string => {
  const body = randomBody();
  return `resp_${crc32Checksum(body)}_${body}`;
};

export const isResponsesResponseId = (value: string): boolean => {
  const match = RESPONSE_ID_PATTERN.exec(value);
  if (match === null) return false;
  const [, checksum, body] = match;
  return crc32Checksum(body) === checksum;
};

const randomBody = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return base64UrlEncode(bytes);
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
};

const crc32Checksum = (input: string): string => {
  const crc = crc32(new TextEncoder().encode(input)) >>> 0;
  return base64UrlEncode(new Uint8Array([(crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff]));
};
