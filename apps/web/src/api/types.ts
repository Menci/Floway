// Control-plane DTOs the SPA consumes — serialized shapes the gateway emits at /api.

import type {
  AliasRules,
  AliasSelection,
  AliasTarget,
  AnnouncedMetadata,
  BillingDimension,
  ChatAliasRules,
  ChatModelInfo,
  ModelAlias,
  ModelEndpointKey,
  ModelEndpoints,
  ModelKind,
  ModelPricing,
  PublicModel,
  PublicModelLimits,
} from '@floway-dev/protocols/common';
import type { UpstreamChatModelConfig, UpstreamModelConfig } from '@floway-dev/provider';
import type { FlagDefaults, FlagOverrides } from '@floway-dev/provider/flags';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '@floway-dev/provider/model';
import type { AddressableForm, ModelPrefixConfig } from '@floway-dev/provider/model-prefix';

export type { BillingDimension, ModelEndpointKey, ModelEndpoints, ModelKind, ModelPricing };
export type { AddressableForm, ModelPrefixConfig };
export type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind };
export type { UpstreamModelConfig };
export type UpstreamChatConfig = UpstreamChatModelConfig;
export type {
  AliasRules, AliasSelection, AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ModelAlias,
  PublicModel, PublicModelLimits,
};

export interface ProxyFallbackEntry {
  id: string;
  colos?: string[];
}

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

// Raw model entries returned by POST /api/upstreams/list-models for custom
// upstreams; permissive superset over the shapes the backend accepts.
export interface CustomRawModel {
  id: string;
  display_name?: string;
  name?: string;
  created?: number;
  owned_by?: string;
  limits?: PublicModelLimits;
  pricing?: ModelPricing;
  kind?: ModelKind;
}

// Each provider's config is served in two shapes over the same wire slot:
//   * Redacted — list endpoint (`GET /api/upstreams`). Secrets stripped to
//     boolean flags (`apiKeySet`, `githubTokenSet`, `refreshTokenSet`).
//   * Full — single-record endpoint (`GET /api/upstreams/:id`) and the
//     blueprint endpoint (`GET /api/upstreams/blueprint?kind=…`). Actual
//     credential fields present. The edit page loads through the full path
//     so every action endpoint can post the record straight back with the
//     credentials the server needs.
// The types below carry both surfaces (secrets optional + presence flag
// optional) so a single `UpstreamRecord` value can flow through both paths.
export interface CustomUpstreamConfig {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic' | 'none';
  endpoints: ModelEndpoints;
  pathOverrides?: Record<string, string>;
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
  apiKey?: string;
  apiKeySet?: boolean;
}

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKey?: string;
  apiKeySet?: boolean;
  models: UpstreamModelConfig[];
}

export interface CopilotUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  user: CopilotUser;
  githubToken?: string;
  githubTokenSet?: boolean;
}

// Per-tier data-plane host GitHub last routed our PAT to. Populated on the
// first successful token exchange and refreshed alongside the bearer token
// (matches vscode-copilot-chat domainServiceImpl.ts). Null on a freshly-
// imported upstream that hasn't completed a token exchange — but the import
// path mints one synchronously, so a null here in steady state means
// something is wrong (PAT revoked, network blocked).
export interface CopilotUpstreamState {
  copilotToken: { baseUrl: string } | null;
}

// Account-pool identity derived from the id_token at codex import. Today's
// contract always operates on a single account, but the array shape lives
// on to keep the wire format stable if we later fan out. `accounts` is an
// empty array on a fresh blueprint (before OAuth exchange populates it).
export interface CodexAccountIdentity {
  email: string;
  chatgptAccountId: string;
  chatgptUserId: string;
  planType: string;
}

export interface CodexUpstreamConfig {
  accounts: CodexAccountIdentity[];
}

export interface OllamaUpstreamConfig {
  baseUrl: string;
  apiKey?: string | null;
  // apiKeySet mirrors customConfig.apiKeySet — the wire never carries the
  // real secret in the redacted projection, only a flag the dashboard uses
  // to render the "leave blank to keep" hint and the "••••••••" placeholder.
  apiKeySet?: boolean;
  models: UpstreamModelConfig[];
}

export interface CodexAccountCredentialState {
  chatgptAccountId: string;
  state: 'active' | 'session_terminated' | 'refresh_failed';
  state_message?: string;
  state_updated_at: string;
  refresh_token?: string;
  refresh_token_set?: boolean;
  accessToken?: { token: string; expiresAt: number; refreshedAt: string } | null;
}

export interface CodexUpstreamState {
  accounts: CodexAccountCredentialState[];
}

export interface CodexQuotaSnapshot {
  observed_at: string;
  active_limit?: string;
  plan_type?: string;
  primary_used_percent?: number;
  primary_window_minutes?: number;
  primary_reset_after_at?: string;
  secondary_used_percent?: number;
  secondary_window_minutes?: number;
  secondary_reset_after_at?: string;
  credits_has_credits?: boolean;
  credits_balance?: number;
  ratelimited_until?: string;
}

export type CodexQuotaSnapshotMap = Record<string, CodexQuotaSnapshot>;

export interface ClaudeCodeAccountIdentity {
  // null when the access token lacks the `user:profile` scope (personal
  // accounts whose CLI flow did not request it). Dashboard substitutes the
  // accountUuid short prefix in that case.
  email: string | null;
  accountUuid: string;
  organizationUuid: string | null;
  // CLI-canonical plan name derived from `organization.organization_type`.
  // null for personal accounts (no organization block) and for unrecognized
  // organization_type values. Dashboard combines this with rateLimitTier
  // below for display ("Max 5×", "Max 20×").
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null;
  // Raw `organization.rate_limit_tier` from Anthropic — e.g.
  // 'default_claude_max_5x'. Free-form so a new tier does not break ingest.
  rateLimitTier: string | null;
}

export interface ClaudeCodeUpstreamConfig {
  accounts: ClaudeCodeAccountIdentity[];
}

export interface ClaudeCodeAccessTokenSummary {
  token?: string;
  expiresAt: number;
  refreshedAt: string;
}

// Anthropic's `anthropic-ratelimit-unified-*` snapshot. The wire shape is
// frozen at the gateway boundary in @floway-dev/provider-claude-code's
// quota.ts; mirror it so the dashboard renders the structured slices and
// can show the raw header map under a debug disclosure.
export interface ClaudeCodeQuotaWindow {
  status: string | null;
  reset: string | null;
  utilization: number | null;
}

export interface ClaudeCodeQuotaSevenDay extends ClaudeCodeQuotaWindow {
  surpassedThreshold: boolean | null;
}

export interface ClaudeCodeQuotaOverage extends ClaudeCodeQuotaWindow {
  disabledReason: string | null;
}

export interface ClaudeCodeQuotaSnapshotData {
  status: string | null;
  reset: string | null;
  fallbackAvailable: boolean | null;
  fallbackPercentage: number | null;
  representativeClaim: string | null;
  overage: ClaudeCodeQuotaOverage | null;
  fiveHour: ClaudeCodeQuotaWindow | null;
  sevenDay: ClaudeCodeQuotaSevenDay | null;
  raw: Record<string, string>;
}

export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number;
  data: ClaudeCodeQuotaSnapshotData;
}

// Live `/api/oauth/usage` probe response cached on the credential. Distinct
// slot from `quotaSnapshot` because the wire shape is owned by Anthropic and
// evolves on their schedule — `data` is `unknown` so a new field never
// blocks dashboard parse. The dashboard walks the known three windows
// (`five_hour`, `seven_day`, `seven_day_sonnet`) and renders anything else
// raw under a debug disclosure.
export interface ClaudeCodeUsageProbeSnapshotEntry {
  fetchedAt: number;
  data: unknown;
}

export interface ClaudeCodeAccountCredentialSummary {
  accountUuid: string;
  // `oauth` is the full Claude Code sign-in (rotating refresh token).
  // `setup-token` is the inference-only long-lived bearer (no refresh).
  tokenKind: 'oauth' | 'setup-token';
  state: 'active' | 'session_terminated' | 'refresh_failed';
  stateMessage?: string;
  stateUpdatedAt: string;
  refreshToken?: string;
  refreshTokenSet?: boolean;
  accessToken: ClaudeCodeAccessTokenSummary | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
  usageProbeSnapshot: ClaudeCodeUsageProbeSnapshotEntry | null;
}

export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredentialSummary[];
}

interface UpstreamRecordBase {
  id: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: FlagOverrides;
  // Provider-declared upstream-level default for every flag on this
  // record. Fed into the flag editor's "Inherit → on/off" hint.
  flag_defaults: FlagDefaults;
  // Public model ids switched off for this upstream. Hidden from the catalog and
  // unroutable, but their per-model metadata stays editable. May include ids no
  // longer present in the live model list.
  disabled_public_model_ids: string[];
  // Ordered proxy fallback list. Each entry pins a proxy id or one of the
  // built-in direct transports (`direct_fetch`, `direct_connect`), plus an
  // optional `colos` whitelist. Empty/missing means all locations; an empty
  // top-level list defaults to `direct_fetch`.
  proxy_fallback_list: ProxyFallbackEntry[];
  // Per-upstream model name prefix. When set, this upstream's models can be
  // addressed in two forms (`unprefixed` and `prefixed`) and listed in either
  // — see `@floway-dev/provider/model-prefix` for the field semantics. Null
  // means "no prefix configured; the upstream advertises and accepts only
  // the bare upstream id."
  model_prefix: ModelPrefixConfig | null;
  color: UpstreamColor | null;
  // SWR models-cache freshness joined from the models_cache table. Both inner
  // values are null on a row that has never been warmed; lastError is set
  // when the most recent warm failed but a prior fetch still populates
  // fetchedAt.
  modelsCache: {
    fetchedAt: number | null;
    lastError: { message: string; at: number } | null;
  };
}

// Kind-keyed discriminated union: each variant pins `kind` and the
// matching `config` / `state` shape, so `switch (record.kind)` narrows
// both fields without an `as` cast. Codex's `codex_quota` field rides on the
// codex variant only.
export type UpstreamRecord =
  | (UpstreamRecordBase & { kind: 'custom'; config: CustomUpstreamConfig; state: null })
  | (UpstreamRecordBase & { kind: 'azure'; config: AzureUpstreamConfig; state: null })
  | (UpstreamRecordBase & { kind: 'copilot'; config: CopilotUpstreamConfig; state: CopilotUpstreamState | null })
  | (UpstreamRecordBase & { kind: 'codex'; config: CodexUpstreamConfig; state: CodexUpstreamState | null; codex_quota?: CodexQuotaSnapshotMap | null })
  | (UpstreamRecordBase & { kind: 'claude-code'; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState | null })
  | (UpstreamRecordBase & { kind: 'ollama'; config: OllamaUpstreamConfig; state: null });

// The action-endpoint wire envelope (matches `upstreamRecordEnvelope` in
// packages/gateway/src/control-plane/schemas.ts): zod's `.passthrough()`
// widens the inferred request type with a string index signature, which
// our discriminated `UpstreamRecord` lacks. Every `{ record: draft, ... }`
// call site funnels its draft through `toRecordEnvelope` to satisfy the
// RPC client without an unsafe cast on the payload as a whole.
export type UpstreamRecordEnvelope = {
  id: string;
  kind: string;
  config: unknown;
  state: unknown;
  proxy_fallback_list?: ProxyFallbackEntry[];
  [key: string]: unknown;
};

export const toRecordEnvelope = (record: UpstreamRecord): UpstreamRecordEnvelope => ({ ...record });

// Mirrors @floway-dev/gateway/control-plane/proxies/serialize. Keep this narrow
// until this app needs the gateway Hono RPC type; pulling gateway in just for
// these DTOs drags the whole backend package graph into the frontend workspace.
export interface ProxyRecord {
  id: string;
  name: string;
  url: string;
  created_at: string;
  updated_at: string;
  dial_timeout_seconds: number | null;
}

export interface BackoffRow {
  proxy_id: string;
  upstream_id: string;
  fail_count: number;
  expires_at: number;
  last_error: string | null;
  last_error_at: number | null;
}

// 409 body returned by DELETE /api/proxies/:id when the row is referenced
// by an upstream's fallback list.
export interface ProxyConflictBody {
  error: string;
  referencing_upstream_ids?: string[];
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string[] | null;
  dump_retention_seconds: number | null;
}

// Raw admin projection returned by GET /api/users. Unlike /auth/me, the
// telemetry flag is not widened by administrator status so it can be edited.
export interface ControlPlaneUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
  canViewGlobalTelemetry: boolean;
  createdAt: string;
}

export interface UpstreamOption {
  id: string;
  name: string;
  kind: UpstreamProviderKind;
  enabled: boolean;
  color: UpstreamColor | null;
}

export interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string; color: UpstreamColor | null }[];
}

export interface SearchConfig {
  provider: 'disabled' | 'tavily' | 'microsoft-grounding' | 'jina';
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
  jina: { apiKey: string };
  passthroughOpenAiSearch: { enabled: boolean; upstreamId: string; model: string };
}

export interface SearchConfigTestResult {
  ok: boolean;
  provider: string;
  query: string;
  results?: { title: string; url: string; previewText: string; pageAge?: string }[];
  error?: { code: string; message: string };
}

export interface CopilotQuotaSnapshot {
  quota_snapshots?: {
    premium_interactions?: {
      entitlement: number;
      remaining: number;
      reset_date?: string;
    };
  };
}

export interface DeviceFlowStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
}

// Return shape of POST /api/upstreams/copilot/oauth/device-login/poll.
// `complete` carries a `patch` the caller merges into its draft record;
// the same patch is targeted-persisted server-side when the caller's
// record has an id.
export type DeviceFlowPoll =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'error'; error: string }
  | {
    status: 'complete';
    user: CopilotUser;
    patch: {
      config: CopilotUpstreamConfig;
      state: CopilotUpstreamState;
    };
  };

// Backup / restore DTOs — the frontend is a pass-through and does not introspect
// individual records, so the data arrays use unknown[].

export interface BackupExportData {
  users: unknown[];
  apiKeys: unknown[];
  upstreams: unknown[];
  proxies: unknown[];
  usage: unknown[];
  searchUsage: unknown[];
  performance?: unknown[];
  performanceIncluded: boolean;
  searchConfig: unknown;
}

export interface BackupExportResponse {
  version: number;
  exportedAt: string;
  data: BackupExportData;
}

export interface BackupImportCounts {
  users: number;
  apiKeys: number;
  upstreams: number;
  proxies: number;
  usage: number;
  searchUsage: number;
  performance: number;
}

export interface BackupImportResponse {
  ok: true;
  imported: BackupImportCounts;
}
