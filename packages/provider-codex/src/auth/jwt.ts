// Decode-only token claim extraction. Signature verification is intentionally
// skipped: an imported credential is an operator-provided secret, and the
// upstream is what decides whether the bearer is actually valid. Every claim
// is optional because the three import sources disagree on what they carry —
// an OAuth id_token has all of them, a sub2api export may have none, and an
// access token may not be a JWT at all.

import { isObject } from './parse-helpers.ts';
import { decodeCanonicalBase64url } from '@floway-dev/protocols/common';

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

// Refresh responses need only update the capability-relevant plan claim. The
// account identity was validated at import, and OpenAI may omit unrelated
// profile claims from a later id_token. Missing plan returns `undefined` so
// callers can preserve the latest observation or use the import-time identity;
// malformed present claims still surface.
export const parseCodexIdTokenPlanType = (idToken: string): string | undefined => {
  const payload = decodeJwtPayload(idToken, 'id_token');
  const auth = payload['https://api.openai.com/auth'];
  if (auth === undefined) return undefined;
  if (!isObject(auth)) throw new Error('id_token https://api.openai.com/auth claim is not an object');
  const planType = auth.chatgpt_plan_type;
  if (planType === undefined) return undefined;
  if (typeof planType !== 'string' || planType === '') throw new Error('id_token has malformed chatgpt_plan_type claim');
  return planType;
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

const decodeBase64UrlToUtf8 = (value: string): string => {
  // JOSE compact serialization uses canonical unpadded Base64URL.
  // https://www.rfc-editor.org/rfc/rfc7515.html#section-2
  const bytes = decodeCanonicalBase64url(value);
  if (bytes === null) throw new TypeError('Invalid canonical Base64URL JWT segment');
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
