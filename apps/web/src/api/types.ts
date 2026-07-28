// Control-plane DTOs the SPA consumes — serialized shapes the gateway emits at /api.

import type { SerializedBackoffRow, SerializedProxyRecord } from '@floway-dev/gateway/control-plane/proxies/serialize';
import type { InferRequestType, InferResponseType } from 'hono/client';
import type { api } from './client';
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

export type UpstreamRecordEnvelope = InferRequestType<
  typeof api.api.upstreams['list-models'].$post
>['json']['record'];

export type ProxyRecord = SerializedProxyRecord;
export type BackoffRow = SerializedBackoffRow;

export type ProxyConflictBody = InferResponseType<typeof api.api.proxies[':id'].$delete, 409>;
export type ApiKey = InferResponseType<typeof api.api.keys.$get, 200>[number];
export type ControlPlaneUser = InferResponseType<typeof api.api.users.$get, 200>[number];
export type UpstreamOption = InferResponseType<typeof api.api.upstreams.options.$get, 200>[number];

export type ControlPlaneModel = InferResponseType<typeof api.api.models.$get, 200>['data'][number];
export type SearchConfig = InferResponseType<typeof api.api['search-config'].$get, 200>;
export type CopilotQuotaSnapshot = InferResponseType<typeof api.api.upstreams.copilot.quota.$post, 200>;
export type DeviceFlowStart = InferResponseType<typeof api.api.upstreams.copilot.oauth['device-login'].start.$post, 200>;
export type BackupExportResponse = InferResponseType<typeof api.api.export.$get, 200>;
export type BackupExportData = BackupExportResponse['data'];
export type BackupImportCounts = InferResponseType<typeof api.api.import.$post, 200>['imported'];
