// Control-plane DTOs the SPA consumes. These mirror the serialized shapes that
// apps/api emits from the unified /api endpoints — keeping them here (rather
// than re-using internal repo types) prevents the bundler from pulling Worker
// runtime code into the browser bundle.

export type UpstreamProviderKind = 'custom' | 'azure' | 'copilot';

export type CustomEndpoint = '/chat/completions' | '/responses' | '/v1/messages';

export interface CustomUpstreamConfig {
  baseUrl: string;
  authStyle: 'bearer' | 'anthropic';
  supportedEndpoints: CustomEndpoint[];
  pathOverrides?: Record<string, string>;
  bearerTokenSet?: boolean;
}

export interface AzureDeployment {
  deployment: string;
  publicModelId?: string;
  supportedEndpoints: string[];
  display_name?: string;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  flagOverrides?: { enabled: boolean; values: Record<string, boolean> };
  limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number };
}

export interface AzureUpstreamConfig {
  endpoint: string;
  apiKeySet?: boolean;
  deployments: AzureDeployment[];
}

export interface CopilotUser {
  login: string;
  avatar_url: string;
  name: string | null;
  id: number;
}

export interface CopilotUpstreamConfig {
  accountType: 'individual' | 'business' | 'enterprise';
  user: CopilotUser;
  githubTokenSet?: boolean;
}

export interface UpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: Record<string, boolean>;
  config: CustomUpstreamConfig | AzureUpstreamConfig | CopilotUpstreamConfig;
}

export interface FlagDef {
  id: string;
  label: string;
  description: string;
  defaultFor: UpstreamProviderKind[];
}

export interface ApiKey {
  id: string;
  name: string;
  key: string;
  created_at: string;
  last_used_at: string | null;
  upstream_ids: string[] | null;
}

export interface ModelEndpointInfo {
  url: string;
  doc?: string;
}

export interface ModelLimits {
  max_context_window_tokens?: number;
  max_prompt_tokens?: number;
  max_output_tokens?: number;
}

export interface PublicModel {
  id: string;
  display_name?: string;
  limits?: ModelLimits;
  endpoints?: Record<string, ModelEndpointInfo>;
  cost?: { input: number; output: number; cache_read?: number; cache_write?: number };
  kind?: 'chat' | 'embedding';
}

export interface ControlPlaneModel extends PublicModel {
  upstreams: { kind: UpstreamProviderKind; id: string; name: string }[];
}

export interface SearchConfig {
  provider: 'disabled' | 'tavily' | 'microsoft-grounding';
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
}

export interface UpstreamTestResult {
  ok: boolean;
  status?: number;
  models?: string[];
  body?: string;
  error?: string;
  model_count?: number;
  probes?: Array<{ deployment: string; endpoint: string; ok: boolean; status?: number; error?: string }>;
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

export interface DeviceFlowPoll {
  status: 'pending' | 'complete' | 'slow_down' | 'error';
  upstream?: UpstreamRecord;
  error?: string;
  interval?: number;
}
