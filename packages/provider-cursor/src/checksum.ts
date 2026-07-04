/**
 * x-cursor-checksum header — pure-compute, no machine fingerprint.
 *
 * Ported from Cursor-To-OpenAI / yet-another-opencode-cursor-auth's
 * generateChecksum, Workers-clean: Uint8Array instead of Buffer, Web Crypto
 * sha256Hex instead of node:crypto createHash. Async because crypto.subtle
 * digest is async — callers precompute once per turn/window and inject the
 * string into AgentTransport via getChecksum.
 *
 * Format: `<base64url(6 obfuscated timestamp bytes)><hex1>/<hex2>`
 * where hex1 = sha256(salt[1]).slice(0,8), hex2 = sha256(token).slice(0,8),
 * and the timestamp is the current time floored to a 30-minute window,
 * divided by 1e6, big-endian into 6 bytes, then run through the XOR/offset
 * obfuscation pass.
 */

import { TEXT_ENCODER } from './proto/encoding.ts';
import { sha256Hex } from '@floway-dev/platform';

/** Base64url-encode a byte buffer (no padding), Workers-clean. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function obfuscate(data: Uint8Array): void {
  let t = 165;
  for (let i = 0; i < data.length; i++) {
    data[i] = ((data[i]! ^ t) + i) & 0xff;
    t = data[i]!;
  }
}

async function shortSha256Hex(input: string): Promise<string> {
  const hex = await sha256Hex(TEXT_ENCODER.encode(input));
  return hex.slice(0, 8);
}

export async function generateCursorChecksum(token: string): Promise<string> {
  const salt = token.split('.');

  // Floor the current time to a 30-minute window, then encode as 6 big-endian
  // bytes (value = ms / 1e6). The windowing makes the checksum stable within
  // each half-hour so repeated requests in a turn share a value.
  const now = new Date();
  now.setMinutes(30 * Math.floor(now.getMinutes() / 30), 0, 0);
  const timestamp = Math.floor(now.getTime() / 1e6);

  const tsBuf = new Uint8Array(6);
  let temp = timestamp;
  for (let i = 5; i >= 0; i--) {
    tsBuf[i] = temp & 0xff;
    temp = Math.floor(temp / 256);
  }
  obfuscate(tsBuf);

  const hex1 = salt[1] ? await shortSha256Hex(salt[1]!) : '00000000';
  const hex2 = await shortSha256Hex(token);

  return `${bytesToBase64Url(tsBuf)}${hex1}/${hex2}`;
}
