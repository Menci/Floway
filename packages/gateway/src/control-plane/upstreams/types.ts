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
  ClaudeCodeQuotaSnapshotEntry as StoredClaudeCodeQuotaSnapshotEntry,
  ClaudeCodeQuotaWindow,
  ClaudeCodeUpstreamConfig as StoredClaudeCodeUpstreamConfig,
  ClaudeCodeUpstreamState as StoredClaudeCodeUpstreamState,
  ClaudeCodeUsageProbeSnapshotEntry,
} from '@floway-dev/provider-claude-code';
import type {
  CodexAccountCredential,
  CodexAccountIdentity,
  CodexQuotaSnapshot,
  CodexQuotaSnapshotMap,
  CodexUpstreamConfig as StoredCodexUpstreamConfig,
  CodexUpstreamState as StoredCodexUpstreamState,
} from '@floway-dev/provider-codex';
import type {
  CopilotUpstreamConfig as StoredCopilotUpstreamConfig,
  CopilotUpstreamState as StoredCopilotUpstreamState,
} from '@floway-dev/provider-copilot';
import type {
  CustomModelsFetch,
  CustomRawModel,
  CustomUpstreamConfig as StoredCustomUpstreamConfig,
} from '@floway-dev/provider-custom';
import type { OllamaUpstreamConfig as StoredOllamaUpstreamConfig } from '@floway-dev/provider-ollama';

export type { ClaudeCodeQuotaWindow, CodexQuotaSnapshot, CodexQuotaSnapshotMap, CustomModelsFetch, CustomRawModel, ProxyFallbackEntry };

type CustomConfigFields = Pick<
  StoredCustomUpstreamConfig,
  'authStyle' | 'baseUrl' | 'endpoints' | 'models' | 'modelsFetch' | 'pathOverrides'
>;

export type CustomUpstreamConfig = CustomConfigFields & {
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
  'chatgptAccountId' | 'state' | 'state_message' | 'state_updated_at'
> & {
  accessToken?: CodexAccountCredential['accessToken'];
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
export type ClaudeCodeQuotaSnapshotEntry = StoredClaudeCodeQuotaSnapshotEntry;

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

type RedactedCustomConfig = CustomConfigFields & { apiKeySet: boolean };
type RedactedAzureConfig = Omit<StoredAzureUpstreamConfig, 'apiKey'> & { apiKeySet: boolean };
type RedactedCopilotConfig = Omit<StoredCopilotUpstreamConfig, 'githubToken'> & { githubTokenSet: boolean };
type RedactedOllamaConfig = Omit<StoredOllamaUpstreamConfig, 'apiKey'> & { apiKeySet: boolean };

type RedactedCodexCredential = Pick<
  CodexAccountCredential,
  'chatgptAccountId' | 'state' | 'state_message' | 'state_updated_at'
> & { refresh_token_set: boolean };

type RedactedClaudeCodeCredential = Pick<
  ClaudeCodeAccountCredential,
  'accountUuid' | 'state' | 'stateMessage' | 'stateUpdatedAt' | 'tokenKind'
> & {
  refreshTokenSet: boolean;
  accessToken: ClaudeCodeAccessTokenSummary | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
  usageProbeSnapshot: ClaudeCodeUsageProbeSnapshotEntry | null;
};

export type RedactedSerializedUpstreamRecord =
  | (SerializedUpstreamRecordBase & { kind: 'custom'; config: RedactedCustomConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'azure'; config: RedactedAzureConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'copilot'; config: RedactedCopilotConfig; state: CopilotUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'codex'; config: StoredCodexUpstreamConfig; state: { accounts: RedactedCodexCredential[] } | null })
  | (SerializedUpstreamRecordBase & { kind: 'claude-code'; config: StoredClaudeCodeUpstreamConfig; state: { accounts: RedactedClaudeCodeCredential[] } | null })
  | (SerializedUpstreamRecordBase & { kind: 'ollama'; config: RedactedOllamaConfig; state: null });

export type FullSerializedUpstreamRecord =
  | (SerializedUpstreamRecordBase & { kind: 'custom'; config: StoredCustomUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'azure'; config: StoredAzureUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'copilot'; config: StoredCopilotUpstreamConfig; state: StoredCopilotUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'codex'; config: StoredCodexUpstreamConfig; state: StoredCodexUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'claude-code'; config: StoredClaudeCodeUpstreamConfig; state: StoredClaudeCodeUpstreamState | null })
  | (SerializedUpstreamRecordBase & { kind: 'ollama'; config: StoredOllamaUpstreamConfig; state: null });

export type SerializedUpstreamRecord = FullSerializedUpstreamRecord;

export type BlueprintSerializedUpstreamRecord =
  | (SerializedUpstreamRecordBase & { kind: 'custom'; config: StoredCustomUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'azure'; config: StoredAzureUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'copilot'; config: StoredCopilotUpstreamConfig; state: null })
  | (SerializedUpstreamRecordBase & { kind: 'codex'; config: { accounts: CodexAccountIdentity[] }; state: { accounts: CodexAccountCredential[] } })
  | (SerializedUpstreamRecordBase & { kind: 'claude-code'; config: { accounts: ClaudeCodeAccountIdentity[] }; state: { accounts: ClaudeCodeAccountCredential[] } })
  | (SerializedUpstreamRecordBase & { kind: 'ollama'; config: StoredOllamaUpstreamConfig; state: null });

export interface ModelsCacheStatus {
  fetchedAt: number | null;
  lastError: { message: string; at: number } | null;
}

type WithResponseProjections<T> = T extends { kind: 'codex' }
  ? T & { modelsCache: ModelsCacheStatus; codex_quota: CodexQuotaSnapshotMap | null }
  : T & { modelsCache: ModelsCacheStatus };

export type RedactedUpstreamResponse = WithResponseProjections<RedactedSerializedUpstreamRecord>;
export type FullUpstreamResponse = WithResponseProjections<FullSerializedUpstreamRecord>;
export type BlueprintUpstreamResponse = BlueprintSerializedUpstreamRecord & { modelsCache: ModelsCacheStatus };

interface DashboardUpstreamRecordBase extends SerializedUpstreamRecordBase {
  modelsCache: ModelsCacheStatus;
}

export type UpstreamRecord =
  | (DashboardUpstreamRecordBase & { kind: 'custom'; config: CustomUpstreamConfig; state: null })
  | (DashboardUpstreamRecordBase & { kind: 'azure'; config: AzureUpstreamConfig; state: null })
  | (DashboardUpstreamRecordBase & { kind: 'copilot'; config: CopilotUpstreamConfig; state: CopilotUpstreamState | StoredCopilotUpstreamState | null })
  | (DashboardUpstreamRecordBase & { kind: 'codex'; config: CodexUpstreamConfig; state: CodexUpstreamState | null; codex_quota?: CodexQuotaSnapshotMap | null })
  | (DashboardUpstreamRecordBase & { kind: 'claude-code'; config: ClaudeCodeUpstreamConfig; state: ClaudeCodeUpstreamState | null })
  | (DashboardUpstreamRecordBase & { kind: 'ollama'; config: OllamaUpstreamConfig; state: null });

export interface ListedUpstreamModel extends UpstreamModelConfig {
  upstreamModelId: string;
  publicModelId: string;
  endpoints: ModelEndpoints;
}

export type ListUpstreamModelsResponse =
  | { kind: 'custom'; data: CustomRawModel[] }
  | { kind: Exclude<UpstreamProviderKind, 'custom'>; data: ListedUpstreamModel[] };
