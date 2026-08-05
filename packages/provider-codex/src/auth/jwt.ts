// Decode-only id_token claim extraction. Signature verification is intentionally
// skipped: the token reached us over TLS from auth.openai.com itself; spending
// effort on signature-validating a token we just fetched would be theatre.

import { base64urlnopad } from '@scure/base';

export interface CodexIdTokenIdentity {
  email: string;
  chatgptAccountId: string;
  chatgptUserId: string;
  planType: string;
}

export const parseCodexIdTokenClaims = (idToken: string): CodexIdTokenIdentity => {
  const segments = idToken.split('.');
  if (segments.length !== 3) throw new Error(`id_token must have 3 segments, got ${segments.length}`);

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64UrlToUtf8(segments[1]));
  } catch (cause) {
    throw new Error('id_token payload is not base64url-encoded JSON', { cause: cause as Error });
  }

  if (!isObject(payload)) throw new Error('id_token payload is not an object');

  const auth = payload['https://api.openai.com/auth'];
  if (!isObject(auth)) throw new Error('id_token missing https://api.openai.com/auth claim');

  // Real-world OpenAI id_tokens carry `email` at the top level; the
  // `https://api.openai.com/profile` claim is sometimes also populated. We
  // accept either source so the import works against every observed shape.
  const profile = payload['https://api.openai.com/profile'];
  const email = (isObject(profile) ? pickStringOptional(profile, 'email') : null)
    ?? pickStringOptional(payload, 'email');
  if (email === null) throw new Error('id_token missing email claim');

  return {
    email,
    chatgptAccountId: pickString(auth, 'chatgpt_account_id'),
    chatgptUserId: pickString(auth, 'chatgpt_user_id'),
    planType: pickString(auth, 'chatgpt_plan_type'),
  };
};

const decodeBase64UrlToUtf8 = (value: string): string => {
  // JOSE compact serialization uses canonical unpadded Base64URL.
  // https://www.rfc-editor.org/rfc/rfc7515.html#section-2
  return new TextDecoder().decode(base64urlnopad.decode(value));
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const pickString = (record: Record<string, unknown>, key: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') throw new Error(`id_token missing or empty ${key} claim`);
  return value;
};

const pickStringOptional = (record: Record<string, unknown>, key: string): string | null => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') return null;
  return value;
};
