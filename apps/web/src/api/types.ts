// Control-plane DTOs the SPA consumes — serialized shapes the gateway emits at /api.

import type { SerializedBackoffRow, SerializedProxyRecord } from '@floway-dev/gateway/control-plane/proxies/serialize';
import type {
  ProxyFallbackEntry,
  UpstreamRecord,
} from '@floway-dev/gateway/control-plane/upstreams/types';
import type {
  AliasRules,
  AliasSelection,
  AliasTarget,
  AnnouncedMetadata,
  BillingMetric,
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
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '@floway-dev/provider/model';
import type { AddressableForm, ModelPrefixConfig } from '@floway-dev/provider/model-prefix';

export type { BillingMetric, ModelEndpointKey, ModelEndpoints, ModelKind, ModelPricing };
export type { AddressableForm, ModelPrefixConfig };
export type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind };
export type { UpstreamModelConfig };
export type UpstreamChatConfig = UpstreamChatModelConfig;
export type {
  AliasRules, AliasSelection, AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ModelAlias,
  PublicModel, PublicModelLimits,
};
export type {
  AzureUpstreamConfig,
  ClaudeCodeAccessTokenSummary,
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaSnapshotData,
  ClaudeCodeQuotaWindow,
  ClaudeCodeUpstreamConfig,
  ClaudeCodeUpstreamState,
  CodexAccountCredentialState,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CodexUpstreamConfig,
  CodexUpstreamState,
  CopilotUpstreamConfig,
  CopilotUpstreamState,
  CopilotUser,
  CustomModelsFetch,
  CustomRawModel,
  CustomUpstreamConfig,
  ListUpstreamModelsResponse,
  ListedUpstreamModel,
  OllamaUpstreamConfig,
  ProxyFallbackEntry,
  UpstreamRecord,
} from '@floway-dev/gateway/control-plane/upstreams/types';

// Zod's passthrough request schema widens this action envelope with a string
// index signature. Keep that request-only shape separate from the precise
// discriminated response record.
export type UpstreamRecordEnvelope = {
  id: string;
  kind: string;
  config: unknown;
  state: unknown;
  proxy_fallback_list?: ProxyFallbackEntry[];
  [key: string]: unknown;
};

export const toRecordEnvelope = (record: UpstreamRecord): UpstreamRecordEnvelope => ({ ...record });

export type ProxyRecord = SerializedProxyRecord;
export type BackoffRow = SerializedBackoffRow;

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
  responses_retention_seconds: number;
}

export interface ControlPlaneUser {
  id: number;
  username: string;
  isAdmin: boolean;
  upstreamIds: string[] | null;
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
  provider: 'disabled' | 'tavily' | 'web-iq' | 'jina';
  tavily: { apiKey: string };
  webIq: { apiKey: string };
  jina: { apiKey: string };
  passthroughOpenAiSearch: { enabled: boolean; upstreamId: string; model: string };
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
