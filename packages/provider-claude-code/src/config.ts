import type { UpstreamRecord } from '@floway-dev/provider';

// One Claude account's operator-managed identity, derived from /v1/oauth/profile
// at import time. Mutating credentials (refreshToken, accessToken, credential
// health) live in ClaudeCodeUpstreamState instead.
export interface ClaudeCodeAccountIdentity {
  // null when the OAuth token lacks `user:profile` scope (the profile
  // endpoint returns 403 and we fall back to a degraded identity). The
  // dashboard shows a placeholder in that case.
  email: string | null;
  accountUuid: string;
  // Anthropic returns null for personal accounts and a UUID for team / org-tier
  // members. Modeled as nullable so the on-disk shape distinguishes "we asked
  // and the upstream said null" from "absent".
  organizationUuid: string | null;
  // The CLI-canonical plan name derived from `organization.organization_type`:
  // 'pro', 'max', 'team', 'enterprise', or null for personal accounts /
  // organization_type values we do not yet recognize. Matches the official
  // CLI's persisted `subscriptionType` field in ~/.claude/.credentials.json.
  // Captured for dashboard display; the dashboard combines it with
  // rateLimitTier below to render "Max 5×" / "Max 20×" etc.
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null;
  // Raw `organization.rate_limit_tier` string passed through verbatim — e.g.
  // 'default_claude_max_5x' / 'default_claude_max_20x' / 'default_claude_pro'.
  // Null for personal accounts (no organization block) and for tokens that
  // hit the 403-fallback path. Not enum-cast so a new Anthropic tier does
  // not break ingest; the dashboard's friendly-label map handles known
  // values and passes unknown values through verbatim.
  rateLimitTier: string | null;
}

// Account pool. v1 always carries exactly one entry — typed as a 1-tuple so
// callers can index accounts[0] without a nullable cushion. The wire shape
// stays array-of-accounts so a future fan-out / round-robin pool feature
// can widen the tuple without a schema migration.
export interface ClaudeCodeUpstreamConfig {
  accounts: [ClaudeCodeAccountIdentity];
}

export type ClaudeCodeUpstreamRecord = UpstreamRecord & {
  kind: 'claude-code';
  config: ClaudeCodeUpstreamConfig;
};

function assertClaudeCodeAccountIdentity(value: unknown, where: string): asserts value is ClaudeCodeAccountIdentity {
  const allowed = new Set(['email', 'accountUuid', 'organizationUuid', 'subscriptionType', 'rateLimitTier'] as const);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key as never)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (obj.email !== null && (typeof obj.email !== 'string' || obj.email === '')) {
    throw new TypeError(`${where}.email must be null or a non-empty string`);
  }
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`);
  }
  if (obj.organizationUuid !== null && (typeof obj.organizationUuid !== 'string' || obj.organizationUuid === '')) {
    throw new TypeError(`${where}.organizationUuid must be null or a non-empty string`);
  }
  if (obj.subscriptionType !== null && obj.subscriptionType !== 'pro' && obj.subscriptionType !== 'max' && obj.subscriptionType !== 'team' && obj.subscriptionType !== 'enterprise') {
    throw new TypeError(`${where}.subscriptionType must be null or one of 'pro' | 'max' | 'team' | 'enterprise', got ${String(obj.subscriptionType)}`);
  }
  if (obj.rateLimitTier !== null && (typeof obj.rateLimitTier !== 'string' || obj.rateLimitTier === '')) {
    throw new TypeError(`${where}.rateLimitTier must be null or a non-empty string`);
  }
}

function assertClaudeCodeUpstreamConfig(value: unknown): asserts value is ClaudeCodeUpstreamConfig {
  const allowed = new Set(['accounts'] as const);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamConfig must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key as never)) {
      throw new TypeError(`ClaudeCodeUpstreamConfig has unexpected key '${key}'`);
    }
  }
  const accounts = obj.accounts;
  if (!Array.isArray(accounts)) {
    throw new TypeError('ClaudeCodeUpstreamConfig.accounts must be an array');
  }
  if (accounts.length !== 1) {
    throw new TypeError(`ClaudeCodeUpstreamConfig.accounts must hold exactly one account (got ${accounts.length})`);
  }
  assertClaudeCodeAccountIdentity(accounts[0], 'ClaudeCodeUpstreamConfig.accounts[0]');
}

export function assertClaudeCodeUpstreamRecord(record: UpstreamRecord): asserts record is ClaudeCodeUpstreamRecord {
  if (record.kind !== 'claude-code') {
    throw new TypeError(`Expected provider 'claude-code', got '${record.kind}'`);
  }
  assertClaudeCodeUpstreamConfig(record.config);
}
