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
import type { AddressableForm, ModelPrefixConfig } from '@floway-dev/provider/model-prefix';

export type { BillingDimension, ModelEndpointKey, ModelEndpoints, ModelKind, ModelPricing };
export type { AddressableForm, ModelPrefixConfig };
export type {
  AliasRules, AliasSelection, AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ModelAlias,
  PublicModel, PublicModelLimits,
};

export type UpstreamProviderKind = 'custom' | 'azure' | 'copilot' | 'codex' | 'claude-code' | 'cursor' | 'ollama';

export interface ProxyFallbackEntry {
  id: string;
  colos?: string[];
}

// Mutable variant of @floway-dev/protocols/common ChatModelInfo. The editor
// mutates these arrays in place during reasoning-level/modality edits, so
// dropping `readonly` here is intentional — the wire shape stays readonly.
export interface UpstreamChatConfig {
  modalities?: { input: ('text' | 'image')[]; output: ('text' | 'image')[] };
  reasoning?: {
    effort?: { supported: string[]; default: string };
    budget_tokens?: { min?: number; max?: number };
    adaptive?: true;
    mandatory?: true;
  };
}

export interface UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId?: string;
  kind: ModelKind;
  endpoints: ModelEndpoints;
  display_name?: string;
  limits?: PublicModelLimits;
  cost?: ModelPricing;
  flagOverrides?: { enabled: boolean; values: Record<string, boolean> };
  chat?: UpstreamChatConfig;
}

export interface CustomModelsFetch {
  enabled: boolean;
  endpoint?: string;
}

// Raw model entries returned by POST /api/upstreams/fetch-models; permissive
// superset over the shapes the backend accepts.
export interface CustomRawModel {
  id: string;
  display_name?: string;
  name?: string;
  created?: number;
  owned_by?: string;
  limits?: PublicModelLimits;
  cost?: ModelPricing;
  kind?: ModelKind;
}

export interface CustomUpstreamConfig {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic' | 'none';
  endpoints: ModelEndpoints;
  pathOverrides?: Record<string, string>;
  modelsFetch: CustomModelsFetch;
  models: UpstreamModelConfig[];
  apiKeySet?: boolean;
}

export interface AzureUpstreamConfig {
  endpoint: string;
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

// Account-pool identities derived from the id_token at codex import. v1
// always carries exactly one account; the array shape lets a future fan-out
// land without a wire-format change. refresh_token lives in state and is
// exposed only as a `refresh_token_set` boolean per account (see
// CodexUpstreamState below).
export interface CodexAccountIdentity {
  email: string;
  chatgptAccountId: string;
  chatgptUserId: string;
  planType: string;
}

export interface CodexUpstreamConfig {
  accounts: [CodexAccountIdentity];
}

export interface OllamaUpstreamConfig {
  baseUrl: string;
  // apiKeySet mirrors customConfig.apiKeySet — the wire never carries the
  // real secret, only a flag the dashboard uses to render the "leave blank to
  // keep" hint and the "••••••••" placeholder.
  apiKeySet?: boolean;
  models: UpstreamModelConfig[];
}

export interface CodexAccountCredentialState {
  chatgptAccountId: string;
  state: 'active' | 'session_terminated' | 'refresh_failed';
  state_message?: string;
  state_updated_at: string;
  refresh_token_set: boolean;
}

export interface CodexUpstreamState {
  accounts: CodexAccountCredentialState[];
}

export interface CursorAccountIdentity {
  email: string;
  userId: string;
}

export interface CursorUpstreamConfig {
  accounts: [CursorAccountIdentity];
  // Operator toggle: send every request in Cursor Max Mode (larger context
  // window, higher usage cost). Absent/false = normal mode.
  maxMode?: boolean;
  // Operator toggle: expose Cursor Tab (StreamCpp) as an OpenAI /v1/completions
  // edit-prediction model. `model` is the cpp model name sent upstream.
  tabCompletion?: {
    enabled: boolean;
    model?: string;
  };
  // Ghost/privacy mode toggle sent as the x-ghost-mode data-plane header.
  // Absent = privacy on (default). Editable via the config panel.
  privacyMode?: boolean;
}

export interface CursorAccessTokenState {
  expiresAt: number;
  refreshedAt: string;
}

export interface CursorAccountCredentialState {
  userId: string;
  state: 'active' | 'session_terminated' | 'refresh_failed';
  state_message?: string;
  state_updated_at: string;
  refresh_token_set: boolean;
  accessToken: CursorAccessTokenState | null;
  quotaSnapshot?: unknown;
}

export interface CursorUpstreamState {
  accounts: CursorAccountCredentialState[];
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

// Claude Code identity + state shapes. Mirror the redacted projections in
// packages/gateway/src/control-plane/upstreams/serialize.ts: refreshToken
// lives in state and surfaces only as the boolean `refreshTokenSet`, and
// accessToken.token is dropped while expiresAt / refreshedAt remain so the
// dashboard can display a relative-time badge.
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
  accounts: [ClaudeCodeAccountIdentity];
}

export interface ClaudeCodeAccessTokenSummary {
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
  refreshTokenSet: boolean;
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
  flag_overrides: Record<string, boolean>;
  // Public model ids switched off for this upstream. Hidden from the catalog and
  // unroutable, but their per-model metadata stays editable. May include ids no
  // longer present in the live model list.
  disabled_public_model_ids: string[];
  // Ordered fallback dial-list. Each entry pins a proxy id (or the literal
  // string `'direct'` for "no proxy") and an optional `colos` whitelist that
  // scopes the entry to specific location tags (Cloudflare colos / the Node
  // `RUNTIME_LOCATION` env var). Empty/missing whitelist means "active in
  // all locations". Empty top-level list means "always direct".
  proxy_fallback_list: ProxyFallbackEntry[];
  // Per-upstream model name prefix. When set, this upstream's models can be
  // addressed in two forms (`unprefixed` and `prefixed`) and listed in either
  // — see `@floway-dev/provider/model-prefix` for the field semantics. Null
  // means "no prefix configured; the upstream advertises and accepts only
  // the bare upstream id."
  model_prefix: ModelPrefixConfig | null;
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
  | (UpstreamRecordBase & { kind: 'codex'; config: CodexUpstreamConfig; state: CodexUpstreamState | null; codex_quota?: CodexQuotaSnapshot | null })
  | (UpstreamRecordBase & { kind: 'claude-code'; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState | null })
  | (UpstreamRecordBase & { kind: 'cursor'; config: CursorUpstreamConfig; state: CursorUpstreamState | null })
  | (UpstreamRecordBase & { kind: 'ollama'; config: OllamaUpstreamConfig; state: null });

export interface FlagDef {
  id: string;
  label: string;
  description: string;
  defaultFor: UpstreamProviderKind[];
}

// Importing the gateway's source-of-truth type as the actual definition (rather
// than redeclaring the shape) makes any future field rename a compile error
// here instead of a runtime mismatch the next time someone refreshes the page.
export type { SerializedProxyRecord as ProxyRecord, SerializedBackoffRow as BackoffRow } from '@floway-dev/gateway/control-plane/proxies/serialize';

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

export interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

export interface SearchConfig {
  provider: 'disabled' | 'tavily' | 'microsoft-grounding' | 'jina';
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
  jina: { apiKey: string };
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

// Mirror of the provider-cursor CursorDashboardUsage shape. Fetched from
// GET /api/upstreams/:id/cursor/quota on the dashboard's Cursor upstream page;
// see packages/provider-cursor/src/quota.ts for field semantics.
export interface CursorDashboardUsage {
  limitCents: number | null;
  totalSpendCents: number;
  autoPercentUsed: number;
  apiPercentUsed: number;
  totalPercentUsed: number;
  billingCycleEndMs: number | null;
}

export interface DeviceFlowStart {
  user_code: string;
  verification_uri: string;
  device_code: string;
  interval: number;
}

export interface DeviceFlowPoll {
  status: 'pending' | 'complete' | 'slow_down' | 'error';
  upstream?: UpstreamRecord;
  error?: string;
  interval?: number;
}
