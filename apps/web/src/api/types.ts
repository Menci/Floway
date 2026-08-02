// Control-plane DTOs the SPA consumes — serialized shapes the gateway emits at /api.

import type { InferRequestType, InferResponseType } from 'hono/client';

import type { api } from './client';
import type { SerializedBackoffRow, SerializedProxyRecord } from '@floway-dev/gateway/control-plane/proxies/serialize';
import type {
  AliasSelection,
  AliasTarget,
  AnnouncedMetadata,
  BillingMetric,
  ChatAliasRules,
  ChatModelInfo,
  ModelAlias,
  ModelEndpoints,
  ModelKind,
  ModelPricing,
  PublicModelLimits,
} from '@floway-dev/protocols/common';
import type { UpstreamModelConfig } from '@floway-dev/provider';
import type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind } from '@floway-dev/provider/model';

export type { BillingMetric, ModelEndpoints, ModelKind, ModelPricing };
export type { UpstreamColor, UpstreamColorPreset, UpstreamProviderKind };
export type { UpstreamModelConfig };
export type {
  AliasSelection, AliasTarget, AnnouncedMetadata, ChatAliasRules, ChatModelInfo, ModelAlias,
  PublicModelLimits,
};
export type {
  ClaudeCodeAccountCredentialSummary,
  ClaudeCodeQuotaSnapshotData,
  ClaudeCodeQuotaWindow,
  CodexAccountCredentialState,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CustomRawModel,
  ListUpstreamModelsResponse,
  UpstreamRecord,
} from '@floway-dev/gateway/control-plane/upstreams/types';

export type UpstreamRecordEnvelope = InferRequestType<
  typeof api.api.upstreams['list-models']['$post']
>['json']['record'];

export type ProxyRecord = SerializedProxyRecord;
export type BackoffRow = SerializedBackoffRow;

export type ApiKey = InferResponseType<typeof api.api.keys.$get, 200>[number];
export type ControlPlaneUser = InferResponseType<typeof api.api.users.$get, 200>[number];
export type UpstreamOption = InferResponseType<typeof api.api['upstream-options']['$get'], 200>[number];

export type ControlPlaneModel = InferResponseType<typeof api.api.models.$get, 200>['data'][number];
export type SearchConfig = InferResponseType<typeof api.api['search-config']['$get'], 200>;
export type CopilotQuotaSnapshot = InferResponseType<typeof api.api.upstreams.copilot.quota.$post, 200>;
export type DeviceFlowStart = InferResponseType<typeof api.api.upstreams.copilot.oauth['device-login']['start']['$post'], 200>;
export type BackupImportCounts = InferResponseType<typeof api.api.import.$post, 200>['imported'];
