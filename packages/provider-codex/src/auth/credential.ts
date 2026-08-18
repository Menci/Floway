import type { CodexAccountIdentity } from '../config.ts';
import { parseCodexTokenClaims, tryParseCodexAccessTokenClaims, type CodexTokenClaims } from './jwt.ts';
import { optionalString, requireString } from './guards.ts';

// The one shape every import source funnels through. JSON exports, the OAuth
// callback, and hand-typed fields all differ in what they carry, so they state
// what they know here and let one place decide what the account's identity is.
export interface CodexCredentialInput {
  accessToken: string;
  refreshToken?: string | null;
  idToken?: string | null;
  expiresAt?: number | null;
  chatgptAccountId?: string | null;
  email?: string | null;
  chatgptUserId?: string | null;
  planType?: string | null;
}

export interface NormalizedCodexCredential {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  identity: CodexAccountIdentity;
}

export const normalizeCodexCredential = (input: CodexCredentialInput): NormalizedCodexCredential => {
  const accessToken = requireString(input.accessToken, 'access token');
  const refreshToken = optionalString(input.refreshToken, 'refresh token');
  const idToken = optionalString(input.idToken, 'id token');
  const explicitAccountId = optionalString(input.chatgptAccountId, 'ChatGPT account ID');
  const explicitEmail = optionalString(input.email, 'email');
  const explicitUserId = optionalString(input.chatgptUserId, 'ChatGPT user ID');
  const explicitPlanType = optionalString(input.planType, 'plan type');
  const sourceExpiresAt = normalizeExpiry(input.expiresAt);

  const idClaims = idToken === null ? EMPTY_CLAIMS : parseCodexTokenClaims(idToken, 'id_token');
  const accessClaims = tryParseCodexAccessTokenClaims(accessToken) ?? EMPTY_CLAIMS;

  // Two tokens naming different accounts means the bundle was assembled wrong,
  // and guessing which half is right would silently attribute traffic and
  // quota to the loser. An explicitly supplied account ID is the operator
  // answering that question, so it settles the disagreement instead.
  if (
    explicitAccountId === null
    && idClaims.chatgptAccountId !== null
    && accessClaims.chatgptAccountId !== null
    && idClaims.chatgptAccountId !== accessClaims.chatgptAccountId
  ) {
    throw new Error('id_token and access_token identify different ChatGPT accounts; provide the intended account ID explicitly');
  }

  return {
    accessToken,
    refreshToken,
    // The bearer owns its own expiry. Source metadata is only a fallback for
    // an opaque access token, or a JWT without an `exp` claim.
    expiresAt: accessClaims.expiresAt ?? sourceExpiresAt,
    identity: {
      // One precedence rule for all four fields: what the operator typed wins,
      // the id_token fills in what they did not, and the access token covers
      // the remainder. That keeps the manual form honest ("what you type is
      // what you get") and lets an operator pin the account, email, or plan
      // even when a stale JWT disagrees.
      chatgptAccountId: explicitAccountId ?? idClaims.chatgptAccountId ?? accessClaims.chatgptAccountId,
      email: explicitEmail ?? idClaims.email ?? accessClaims.email,
      chatgptUserId: explicitUserId ?? idClaims.chatgptUserId ?? accessClaims.chatgptUserId,
      planType: explicitPlanType ?? idClaims.planType ?? accessClaims.planType,
    },
  };
};

const EMPTY_CLAIMS: CodexTokenClaims = {
  email: null,
  chatgptAccountId: null,
  chatgptUserId: null,
  planType: null,
  expiresAt: null,
};

const normalizeExpiry = (value: unknown): number | null => {
  if (value === undefined || value === null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError('access token expiry must be a non-negative finite unix timestamp in milliseconds');
  }
  return value;
};
