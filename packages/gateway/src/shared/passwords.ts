import { timingSafeEqual } from './timing-safe-equal.ts';

// Cloudflare Workers' Web Crypto refuses PBKDF2 with iterations above 100k as a
// CPU-time DoS guard ("Pbkdf2 failed: iteration counts above 100000 are not
// supported"). 100k is below OWASP's current 600k recommendation for
// PBKDF2-SHA256 but is the runtime ceiling we have.
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
export const PASSWORD_HASH_SCHEME = 'pbkdf2-sha256';

const utf8 = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const fromBase64 = (b64: string): Uint8Array => {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

const deriveBits = async (plaintext: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> => {
  const key = await crypto.subtle.importKey('raw', utf8.encode(plaintext), 'PBKDF2', false, ['deriveBits']);
  // crypto.subtle rejects Uint8Array views over SharedArrayBuffer; copy into a fresh ArrayBuffer.
  const saltBuffer = new Uint8Array(salt).buffer;
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer, iterations }, key, HASH_BITS);
  return new Uint8Array(bits);
};

export const hashPassword = async (plaintext: string): Promise<string> => {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await deriveBits(plaintext, salt, ITERATIONS);
  return `${PASSWORD_HASH_SCHEME}$${ITERATIONS}$${toBase64(salt)}$${toBase64(bits)}`;
};

// Returns false on any structural failure of the encoded string. The caller
// presents the same response either way; surfacing the parse error would only
// help an attacker distinguish "no such user" from "stored hash corrupted".
export const verifyPassword = async (plaintext: string, encoded: string): Promise<boolean> => {
  const parts = encoded.split('$');
  if (parts.length !== 4 || parts[0] !== PASSWORD_HASH_SCHEME) return false;
  const iters = Number(parts[1]);
  if (!Number.isFinite(iters) || iters < 1000 || iters > 10_000_000) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  if (expected.length !== HASH_BITS / 8) return false;
  const actual = await deriveBits(plaintext, salt, iters);
  return timingSafeEqual(actual, expected);
};

// Stable dummy hash used to flatten the login timing oracle: the no-user /
// no-passwordHash branches of /auth/login burn the same PBKDF2 work as a real
// verify, so request latency cannot distinguish "user exists" from "user does
// not exist".
let dummyHash: Promise<string> | null = null;
export const dummyPasswordHash = (): Promise<string> => {
  dummyHash ??= hashPassword('');
  return dummyHash;
};
