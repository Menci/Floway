export const parseServerSecret = (value: unknown, field = 'serverSecret'): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`${field} must be exactly 64 lowercase hexadecimal characters`);
  }
  return value;
};

export const serverSecretBytes = (value: unknown, field = 'serverSecret'): Uint8Array => {
  const secret = parseServerSecret(value, field);
  return decodeHex(secret);
};

export const generateServerSecret = (): string =>
  encodeHex(crypto.getRandomValues(new Uint8Array(32)));
import { decodeHex, encodeHex } from './base-encoding.ts';
