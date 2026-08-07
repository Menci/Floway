import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { jsonByteChunks } from './json-request.ts';

export const sha256Json = (value: unknown, prefix = ''): Uint8Array => {
  const hash = sha256.create();
  if (prefix !== '') hash.update(new TextEncoder().encode(prefix));
  for (const chunk of jsonByteChunks(value)) hash.update(chunk);
  return hash.digest();
};

export const sha256JsonHex = (value: unknown, prefix = ''): string =>
  bytesToHex(sha256Json(value, prefix));
