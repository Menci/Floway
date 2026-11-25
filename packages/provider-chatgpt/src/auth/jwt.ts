// Decode-only token claim extraction. Signature verification is intentionally
// skipped: an imported credential is an operator-provided secret, and the
// upstream is what decides whether the bearer is actually valid. Every claim
// is optional because the three import sources disagree on what they carry —
// an OAuth id_token has all of them, a sub2api export may have none, and an
// access token may not be a JWT at all.

import { isObject } from './guards.ts';
import type { Result } from '@floway-dev/pipeline';
import { decodeCanonicalBase64url } from '@floway-dev/protocols/common';

export interface ChatGPTTokenClaims {
  email: string | null;
  chatgptAccountId: string | null;
  chatgptUserId: string | null;
  planType: string | null;
  expiresAt: number | null;
}

export const parseChatGPTTokenClaims = (token: string, label = 'token'): ChatGPTTokenClaims => {
  const decoded = decodeJwtPayload(token, label);
  if (!decoded.ok) throw decoded.error;
  return projectTokenClaims(decoded.value);
};

const projectTokenClaims = (payload: Record<string, unknown>): ChatGPTTokenClaims => {
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
export const tryParseChatGPTAccessTokenClaims = (accessToken: string): ChatGPTTokenClaims | null => {
  const decoded = decodeJwtPayload(accessToken, 'access_token');
  return decoded.ok ? projectTokenClaims(decoded.value) : null;
};

// Refresh responses need only update the capability-relevant plan claim. The
// account identity was validated at import, and OpenAI may omit unrelated
// profile claims from a later id_token. Missing plan returns `undefined` so
// callers can preserve the latest observation or use the import-time identity;
// malformed present claims still surface.
export const parseChatGPTIdTokenPlanType = (idToken: string): Result<string | undefined, Error> => {
  const decoded = decodeJwtPayload(idToken, 'id_token');
  if (!decoded.ok) return decoded;
  const auth = decoded.value['https://api.openai.com/auth'];
  if (auth === undefined) return { ok: true, value: undefined };
  if (!isObject(auth)) return { ok: false, error: new Error('id_token https://api.openai.com/auth claim is not an object') };
  const planType = auth.chatgpt_plan_type;
  if (planType === undefined) return { ok: true, value: undefined };
  if (typeof planType !== 'string' || planType === '') return { ok: false, error: new Error('id_token has malformed chatgpt_plan_type claim') };
  return { ok: true, value: planType };
};

const decodeJwtPayload = (token: string, label: string): Result<Record<string, unknown>, Error> => {
  const segments = token.split('.');
  if (segments.length !== 3) return { ok: false, error: new Error(`${label} must have 3 segments, got ${segments.length}`) };
  // JOSE compact serialization uses canonical unpadded Base64URL.
  // https://www.rfc-editor.org/rfc/rfc7515.html#section-2
  const bytes = decodeCanonicalBase64url(segments[1]);
  if (bytes === null) return {
    ok: false,
    error: new Error(`${label} payload is not base64url-encoded JSON`, { cause: new TypeError('Invalid canonical Base64URL JWT segment') }),
  };
  const text = new TextDecoder().decode(bytes);

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) throw cause;
    return { ok: false, error: new Error(`${label} payload is not base64url-encoded JSON`, { cause }) };
  }
  if (!isObject(payload)) return { ok: false, error: new Error(`${label} payload is not an object`) };
  return { ok: true, value: payload };
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
