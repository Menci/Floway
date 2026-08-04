// Decode-only token claim extraction. Signature verification is intentionally
// skipped: an imported credential is an operator-provided secret, and the
// upstream is what decides whether the bearer is actually valid. Every claim
// is optional because the three import sources disagree on what they carry —
// an OAuth id_token has all of them, a sub2api export may have none, and an
// access token may not be a JWT at all.

import { isObject } from './parse-helpers.ts';

export interface CodexTokenClaims {
  email: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  planType: string | null;
  expiresAt: number | null;
}

export const parseCodexTokenClaims = (token: string, label = 'token'): CodexTokenClaims => {
  const payload = decodeJwtPayload(token, label);
  const auth = payload['https://api.openai.com/auth'];
  const profile = payload['https://api.openai.com/profile'];

  // Real-world OpenAI tokens carry `email` at the top level; the
  // `https://api.openai.com/profile` claim is sometimes also populated. Accept
  // either source so the import works against every observed shape.
  const email = (isObject(profile) ? pickStringOptional(profile, 'email') : null)
    ?? pickStringOptional(payload, 'email');

  return {
    email,
    chatgptAccountId: isObject(auth) ? pickStringOptional(auth, 'chatgpt_account_id') : null,
    chatgptUserId: isObject(auth) ? pickStringOptional(auth, 'chatgpt_user_id') : null,
    planType: isObject(auth) ? pickStringOptional(auth, 'chatgpt_plan_type') : null,
    expiresAt: pickExpiry(payload),
  };
};

// An access token may be opaque. A decode failure therefore means only that
// identity and expiry cannot be inferred from it; it says nothing about
// whether the bearer works.
export const tryParseCodexAccessTokenClaims = (accessToken: string): CodexTokenClaims | null => {
  try {
    return parseCodexTokenClaims(accessToken, 'access_token');
  } catch {
    return null;
  }
};

const decodeJwtPayload = (token: string, label: string): Record<string, unknown> => {
  const segments = token.split('.');
  if (segments.length !== 3) throw new Error(`${label} must have 3 segments, got ${segments.length}`);

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlToUtf8(segments[1]));
  } catch (cause) {
    throw new Error(`${label} payload is not base64url-encoded JSON`, { cause: cause as Error });
  }
  if (!isObject(payload)) throw new Error(`${label} payload is not an object`);
  return payload;
};

// atob rejects unpadded base64; OpenAI tokens arrive unpadded, so we pad.
const decodeBase64UrlToUtf8 = (value: string): string => {
  const standard = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
};

const pickStringOptional = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') return null;
  return value;
};

const pickExpiry = (payload: Record<string, unknown>): number | null => {
  const value = payload.exp;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value * 1000;
};
