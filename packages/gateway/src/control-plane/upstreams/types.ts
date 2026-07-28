import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type {
  FlagDefaults,
  FlagOverrides,
  ModelPrefixConfig,
  ProxyFallbackEntry,
  UpstreamColor,
  UpstreamModelConfig,
  UpstreamProviderKind,
} from '@floway-dev/provider';
import type { AzureUpstreamConfig as StoredAzureUpstreamConfig } from '@floway-dev/provider-azure';
import type {
  ClaudeCodeAccessTokenEntry,
  ClaudeCodeAccountCredential,
  ClaudeCodeAccountIdentity,
  ClaudeCodeQuotaSnapshot,
  ClaudeCodeQuotaWindow,
  ClaudeCodeUpstreamConfig as StoredClaudeCodeUpstreamConfig,
  ClaudeCodeUsageProbeSnapshotEntry,
} from '@floway-dev/provider-claude-code';
import type {
  CodexAccountCredential,
  CodexAccountIdentity,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CodexUpstreamConfig as StoredCodexUpstreamConfig,
} from '@floway-dev/provider-codex';
import type { CopilotUpstreamConfig as StoredCopilotUpstreamConfig } from '@floway-dev/provider-copilot';
import type {
  CustomModelsFetch,
  CustomRawModel,
  CustomUpstreamConfig as StoredCustomUpstreamConfig,
} from '@floway-dev/provider-custom';
import type { OllamaUpstreamConfig as StoredOllamaUpstreamConfig } from '@floway-dev/provider-ollama';

export type { ClaudeCodeQuotaWindow, CodexQuotaSnapshot, CodexQuotaSnapshotMap, CustomModelsFetch, CustomRawModel, ProxyFallbackEntry };

export type CustomUpstreamConfig = Pick<
  StoredCustomUpstreamConfig,
  'authStyle' | 'baseUrl' | 'endpoints' | 'models' | 'modelsFetch' | 'pathOverrides'
> & {
  apiKey?: string;
  apiKeySet?: boolean;
};

export type AzureUpstreamConfig = Omit<StoredAzureUpstreamConfig, 'apiKey'> & {
  apiKey?: string;
  apiKeySet?: boolean;
};

export type CopilotUser = StoredCopilotUpstreamConfig['user'];

export type CopilotUpstreamConfig = Omit<StoredCopilotUpstreamConfig, 'githubToken'> & {
  githubToken?: string;
  githubTokenSet?: boolean;
};

export interface CopilotUpstreamState {
  copilotToken: { baseUrl: string } | null;
}

export type CodexUpstreamConfig = Omit<StoredCodexUpstreamConfig, 'accounts'> & {
  accounts: CodexAccountIdentity[];
};

export type OllamaUpstreamConfig = Omit<StoredOllamaUpstreamConfig, 'apiKey'> & {
  apiKey?: string | null;
  apiKeySet?: boolean;
};

export type CodexAccountCredentialState = Pick<
  CodexAccountCredential,
  'accessToken' | 'chatgptAccountId' | 'state' | 'state_message' | 'state_updated_at'
> & {
  refresh_token?: string;
  refresh_token_set?: boolean;
};

export interface CodexUpstreamState {
  accounts: CodexAccountCredentialState[];
}

export type ClaudeCodeUpstreamConfig = Omit<StoredClaudeCodeUpstreamConfig, 'accounts'> & {
  accounts: ClaudeCodeAccountIdentity[];
};

export type ClaudeCodeAccessTokenSummary = Omit<ClaudeCodeAccessTokenEntry, 'token'> & {
  token?: string;
};

export type ClaudeCodeQuotaSnapshotData = ClaudeCodeQuotaSnapshot;

export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number;
  data: ClaudeCodeQuotaSnapshotData;
}

export type ClaudeCodeAccountCredentialSummary = Pick<
  ClaudeCodeAccountCredential,
  'accountUuid' | 'state' | 'stateMessage' | 'stateUpdatedAt' | 'tokenKind'
> & {
  refreshToken?: string | null;
  refreshTokenSet?: boolean;
  accessToken: ClaudeCodeAccessTokenSummary | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
  usageProbeSnapshot: ClaudeCodeUsageProbeSnapshotEntry | null;
};

export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredentialSummary[];
}

interface SerializedUpstreamRecordBase {
  id: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: FlagOverrides;
  flag_defaults: FlagDefaults;
  disabled_public_model_ids: string[];
  proxy_fallback_list: ProxyFallbackEntry[];
  model_prefix: ModelPrefixConfig | null;
  color: UpstreamColor | null;
}

export type SerializedUpstreamRecord =
  | (SerializedUpstreamRecordBase & { kind: 'custom'; config: CustomUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'azure'; config: AzureUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'copilot'; config: CopilotUpstreamConfig; state: CopilotUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'codex'; config: CodexUpstreamConfig; state: CodexUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'claude-code'; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'ollama'; config: OllamaUpstreamConfig; state: null });

export interface ModelsCacheStatus {
  fetchedAt: number | null;
  lastError: { message: string; at: number } | null;
}

type WithResponseProjections<T extends SerializedUpstreamRecord> = T extends { kind: 'codex' }
  ? T & { modelsCache: ModelsCacheStatus; codex_quota?: CodexQuotaSnapshotMap | null }
  : T & { modelsCache: ModelsCacheStatus };

export type UpstreamRecord = WithResponseProjections<SerializedUpstreamRecord>;

export interface ListedUpstreamModel extends UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId: string;
  endpoints: ModelEndpoints;
}

export type ListUpstreamModelsResponse =
  | { kind: 'custom'; data: CustomRawModel[] }
  | { kind: Exclude<UpstreamProviderKind, 'custom'>; data: ListedUpstreamModel[] };
