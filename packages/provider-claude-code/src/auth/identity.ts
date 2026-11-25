import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { CLAUDE_CODE_PROFILE_URL } from '../constants.ts';
import { claudeCodeLog } from '../log.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

// Identity derived from `GET /api/oauth/profile` plus the optional CLI
// `subscriptionType` field. The Anthropic upstream returns nested
// `account.uuid` / `organization.uuid`; we flatten at the boundary so the
// rest of the package never re-handles the wire shape.
//
// `email` is nullable because Anthropic only exposes it to tokens carrying
// the `user:profile` scope. A token minted with the inference-only scope
// (some Claude Code subscription deployments do this) gets 403 on the
// profile endpoint, and we fall back to a degraded identity rather than
// refusing to import — see fetchClaudeCodeIdentity for the fallback shape.
export interface ClaudeCodeIdentity {
  email: string | null;
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null;
  rateLimitTier: string | null;
}

// Cross-checked third-party gateways:
// https://github.com/Wei-Shaw/claude-relay-service/blob/7dc21cf2820a6784831f289442a38d58fe827f34/src/services/account/claudeAccountService.js#L2241
// https://github.com/ghboke/claude-code-reverse/blob/570324dac73ef43bdcd36660188f3cb66524e572/THIRD_PARTY_CLIENT_GUIDE.md
//
// The wire shape is:
// { account: { uuid, email, has_claude_max, has_claude_pro, ... },
//   organization: { uuid, organization_type: 'claude_max'|'claude_pro'|...,
//                   rate_limit_tier: 'default_claude_max_20x'|'default_claude_max_5x'|... } }
export const fetchClaudeCodeIdentity = async (
  accessToken: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeIdentity> => {
  const response = await fetcher(CLAUDE_CODE_PROFILE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch (cause) {
    throw new Error(`Claude Code /api/oauth/profile returned non-JSON body (${response.status})`, { cause: cause as Error });
  }

  // 403 with a `permission_error` body means the token was minted without
  // the `user:profile` scope. Fall back to a degraded identity (deterministic
  // UUID-shaped id derived from the token, nulls for personal fields) so
  // credential ingestion succeeds for inference-only tokens. Anthropic's
  // `permission_error` shape is `{ "error": { "type": "permission_error",
  // ... } }`; we don't strict-match the message because it drifts over time,
  // only the type discriminator.
  let parsedError: Record<string, unknown> | null = null;
  if (typeof parsed === 'object' && parsed !== null) {
    const errorField = (parsed as Record<string, unknown>).error;
    if (typeof errorField === 'object' && errorField !== null) {
      parsedError = errorField as Record<string, unknown>;
    }
  }
  if (response.status === 403 && parsedError?.type === 'permission_error') {
    const accountUuid = deriveDegradedAccountUuid(accessToken);
    claudeCodeLog.withFields({
      account_uuid: accountUuid,
      reason: 'profile_403_missing_user_profile_scope',
    }).warn('claude_code_identity_degraded_fallback');
    return { email: null, accountUuid, organizationUuid: null, subscriptionType: null, rateLimitTier: null };
  }

  if (!response.ok) {
    const message = parsedError !== null && typeof parsedError.message === 'string' ? parsedError.message : null;
    throw new Error(`Claude Code /api/oauth/profile returned ${response.status}: ${message ?? rawText.slice(0, 256)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Claude Code /api/oauth/profile response is not an object');
  }
  const root = parsed as Record<string, unknown>;
  const account = root.account;
  if (typeof account !== 'object' || account === null) {
    throw new Error('Claude Code /api/oauth/profile response missing `account`');
  }
  const accountObj = account as Record<string, unknown>;
  const accountUuid = accountObj.uuid;
  const email = accountObj.email;
  if (typeof accountUuid !== 'string' || accountUuid === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.uuid`');
  }
  if (typeof email !== 'string' || email === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.email`');
  }

  let organizationUuid: string | null = null;
  let organizationType: string | null = null;
  let rateLimitTier: string | null = null;
  const organization = root.organization;
  if (typeof organization === 'object' && organization !== null) {
    const orgObj = organization as Record<string, unknown>;
    if (typeof orgObj.uuid === 'string' && orgObj.uuid !== '') {
      organizationUuid = orgObj.uuid;
    }
    if (typeof orgObj.organization_type === 'string' && orgObj.organization_type !== '') {
      organizationType = orgObj.organization_type;
    }
    if (typeof orgObj.rate_limit_tier === 'string' && orgObj.rate_limit_tier !== '') {
      rateLimitTier = orgObj.rate_limit_tier;
    }
  }

  return {
    email,
    accountUuid,
    organizationUuid,
    subscriptionType: deriveSubscriptionType(organizationType),
    rateLimitTier,
  };
};

// Format the first 32 hex chars of sha256(accessToken) into the canonical
// 8-4-4-4-12 UUID layout so the degraded id sorts and displays consistently
// with real Anthropic account UUIDs. Not a real UUID v4 — we don't set the
// version/variant nibbles, because this is purely a local dedup key and the
// upstream never sees it.
const deriveDegradedAccountUuid = (accessToken: string): string => {
  const hex = bytesToHex(sha256(new TextEncoder().encode(accessToken))).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// Maps `organization_type` to the CLI-canonical plan name the official CC
// binary persists in `~/.claude/.credentials.json`'s `subscriptionType`
// field. The deriver in @anthropic-ai/claude-code-darwin-arm64 2.x's
// bundled binary follows the same switch (`icn` function):
//   claude_max → 'max'    claude_pro → 'pro'
//   claude_team → 'team'  claude_enterprise → 'enterprise'
// Personal accounts arrive with no `organization` block (Anthropic's
// profile endpoint omits it) — null. Unrecognized organization_type
// strings also return null so a new Anthropic tier does not break ingest;
// we log the unknown value for operator visibility. Rate-limit / usage
// tier disambiguation (5x vs 20x Max) is preserved in a separate
// `rateLimitTier` field on the identity object, mirroring the CLI's
// two-field shape.
const deriveSubscriptionType = (
  organizationType: string | null,
): 'pro' | 'max' | 'team' | 'enterprise' | null => {
  if (organizationType === null) return null;
  if (organizationType === 'claude_max') return 'max';
  if (organizationType === 'claude_pro') return 'pro';
  if (organizationType === 'claude_enterprise') return 'enterprise';
  if (organizationType === 'claude_team') return 'team';
  claudeCodeLog.withField('organization_type', organizationType).warn('claude_code_unknown_organization_type');
  return null;
};
