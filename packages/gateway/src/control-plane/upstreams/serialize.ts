import { flagDefaultsForKind } from '../../data-plane/providers/registry.ts';
import type { FlagDefaults, FlagOverrides, ModelPrefixConfig, ProxyFallbackEntry, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';

export interface SerializedUpstreamRecord {
  id: string;
  kind: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
  flag_overrides: FlagOverrides;
  // Pure per-kind derivation of the record's effective flag baseline.
  flag_defaults: FlagDefaults;
  disabled_public_model_ids: string[];
  proxy_fallback_list: ProxyFallbackEntry[];
  model_prefix: ModelPrefixConfig | null;
  config: unknown;
  state: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <T>(value: T): T => structuredClone(value);

const hasSecret = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

const assertAccountsArray = (upstream: UpstreamRecord, accounts: unknown): Record<string, unknown>[] => {
  if (!Array.isArray(accounts)) {
    throw new Error(`Upstream ${upstream.id} (${upstream.kind}) has malformed accounts: expected array`);
  }
  return accounts.map((account, index) => {
    if (!isRecord(account)) {
      throw new Error(`Upstream ${upstream.id} (${upstream.kind}) account[${index}] is malformed: expected object`);
    }
    return account;
  });
};

const serializeOpaqueRecord = (upstream: UpstreamRecord, field: string, value: unknown): Record<string, unknown> | null => {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error(`Upstream ${upstream.id} (${upstream.kind}) has malformed ${field}: expected object or null`);
  }
  return clone(value);
};

const redactedConfig = (upstream: UpstreamRecord): unknown => {
  if (!isRecord(upstream.config)) {
    throw new Error(`Upstream ${upstream.id} (${upstream.kind}) has malformed config: expected object`);
  }
  const config = upstream.config;

  switch (upstream.kind) {
  case 'custom':
    return {
      ...(config.baseUrl !== undefined ? { baseUrl: clone(config.baseUrl) } : {}),
      ...(config.authStyle !== undefined ? { authStyle: clone(config.authStyle) } : {}),
      ...(config.endpoints !== undefined ? { endpoints: clone(config.endpoints) } : {}),
      ...(config.pathOverrides !== undefined ? { pathOverrides: clone(config.pathOverrides) } : {}),
      ...(config.modelsFetch !== undefined ? { modelsFetch: clone(config.modelsFetch) } : {}),
      ...(config.models !== undefined ? { models: clone(config.models) } : {}),
      apiKeySet: hasSecret(config.apiKey),
    };
  case 'azure':
    return {
      ...(config.endpoint !== undefined ? { endpoint: clone(config.endpoint) } : {}),
      ...(config.models !== undefined ? { models: clone(config.models) } : {}),
      apiKeySet: hasSecret(config.apiKey),
    };
  case 'copilot':
    return {
      ...(config.user !== undefined ? { user: clone(config.user) } : {}),
      githubTokenSet: hasSecret(config.githubToken),
    };
  case 'codex':
    // refresh_token lives in state and is redacted by redactedState.
    return {
      accounts: assertAccountsArray(upstream, config.accounts).map(a => ({
        ...(a.email !== undefined ? { email: clone(a.email) } : {}),
        ...(a.chatgptAccountId !== undefined ? { chatgptAccountId: clone(a.chatgptAccountId) } : {}),
        ...(a.chatgptUserId !== undefined ? { chatgptUserId: clone(a.chatgptUserId) } : {}),
        ...(a.planType !== undefined ? { planType: clone(a.planType) } : {}),
      })),
    };
  case 'claude-code':
    // refreshToken lives in state and is redacted by redactedState.
    return {
      accounts: assertAccountsArray(upstream, config.accounts).map(a => ({
        ...(a.email !== undefined ? { email: clone(a.email) } : {}),
        ...(a.accountUuid !== undefined ? { accountUuid: clone(a.accountUuid) } : {}),
        ...(a.organizationUuid !== undefined ? { organizationUuid: clone(a.organizationUuid) } : {}),
        ...(a.subscriptionType !== undefined ? { subscriptionType: clone(a.subscriptionType) } : {}),
        ...(a.rateLimitTier !== undefined ? { rateLimitTier: clone(a.rateLimitTier) } : {}),
      })),
    };
  case 'ollama':
    return {
      ...(config.baseUrl !== undefined ? { baseUrl: clone(config.baseUrl) } : {}),
      ...(config.models !== undefined ? { models: clone(config.models) } : {}),
      apiKeySet: hasSecret(config.apiKey),
    };
  default: {
    const exhaustive: never = upstream.kind;
    throw new Error(`Unknown upstream provider for redaction: ${String(exhaustive)}`);
  }
  }
};

const redactedState = (upstream: UpstreamRecord): unknown => {
  if (upstream.state === null || upstream.state === undefined) return null;
  if (!isRecord(upstream.state)) {
    throw new Error(`Upstream ${upstream.id} (${upstream.kind}) has malformed state: expected object`);
  }
  const state = upstream.state;

  switch (upstream.kind) {
  case 'codex':
    return {
      accounts: assertAccountsArray(upstream, state.accounts).map(a => ({
        ...(a.chatgptAccountId !== undefined ? { chatgptAccountId: clone(a.chatgptAccountId) } : {}),
        ...(a.state !== undefined ? { state: clone(a.state) } : {}),
        ...(a.state_message !== undefined ? { state_message: clone(a.state_message) } : {}),
        state_updated_at: clone(a.state_updated_at),
        refresh_token_set: hasSecret(a.refresh_token),
      })),
    };
  case 'claude-code':
    return {
      accounts: assertAccountsArray(upstream, state.accounts).map(a => {
        // accessToken.token is dropped; expiresAt + refreshedAt are surfaced to the dashboard.
        const accessToken = a.accessToken === null
          ? null
          : isRecord(a.accessToken)
            ? { expiresAt: clone(a.accessToken.expiresAt), refreshedAt: clone(a.accessToken.refreshedAt) }
            : (() => { throw new Error(`Upstream ${upstream.id} (${upstream.kind}) has malformed accessToken: expected object or null`); })();
        return {
          ...(a.accountUuid !== undefined ? { accountUuid: clone(a.accountUuid) } : {}),
          ...(a.tokenKind !== undefined ? { tokenKind: clone(a.tokenKind) } : {}),
          ...(a.state !== undefined ? { state: clone(a.state) } : {}),
          ...(a.stateMessage !== undefined ? { stateMessage: clone(a.stateMessage) } : {}),
          stateUpdatedAt: clone(a.stateUpdatedAt),
          refreshTokenSet: hasSecret(a.refreshToken),
          accessToken,
          quotaSnapshot: serializeOpaqueRecord(upstream, 'quotaSnapshot', a.quotaSnapshot),
          // usageProbeSnapshot's wire shape is owned by Anthropic's
          // /api/oauth/usage endpoint and evolves on their schedule, so we
          // round-trip the entry without re-shaping any inner fields.
          usageProbeSnapshot: serializeOpaqueRecord(upstream, 'usageProbeSnapshot', a.usageProbeSnapshot),
        };
      }),
    };
  case 'copilot': {
    // Expose only the per-tier baseUrl the dashboard renders an account-type
    // badge from. Bearer token + expiry stay server-side: short-lived auth
    // material has no presentation use.
    const token = serializeOpaqueRecord(upstream, 'copilotToken', state.copilotToken);
    const baseUrl = typeof token?.baseUrl === 'string' ? token.baseUrl : null;
    return { copilotToken: baseUrl !== null ? { baseUrl } : null };
  }
  case 'custom':
  case 'azure':
  case 'ollama':
    // These providers have no autonomous state.
    return null;
  default: {
    const exhaustive: never = upstream.kind;
    throw new Error(`Unknown upstream provider for state redaction: ${String(exhaustive)}`);
  }
  }
};

const serializeBase = (
  upstream: UpstreamRecord,
  config: unknown,
  state: unknown,
): SerializedUpstreamRecord => ({
  id: upstream.id,
  kind: upstream.kind,
  name: upstream.name,
  enabled: upstream.enabled,
  sort_order: upstream.sortOrder,
  created_at: upstream.createdAt,
  updated_at: upstream.updatedAt,
  flag_overrides: { ...upstream.flagOverrides },
  flag_defaults: flagDefaultsForKind(upstream.kind),
  disabled_public_model_ids: [...upstream.disabledPublicModelIds],
  proxy_fallback_list: upstream.proxyFallbackList.map(entry => entry.colos === undefined ? { id: entry.id } : { id: entry.id, colos: [...entry.colos] }),
  model_prefix: upstream.modelPrefix === null ? null : clone(upstream.modelPrefix),
  config,
  state,
});

export const upstreamRecordToJson = (upstream: UpstreamRecord): SerializedUpstreamRecord =>
  serializeBase(upstream, redactedConfig(upstream), redactedState(upstream));

export const upstreamRecordToFullJson = (upstream: UpstreamRecord): SerializedUpstreamRecord =>
  serializeBase(upstream, clone(upstream.config), clone(upstream.state));

// Shape-complete UpstreamRecord blank for `kind`, never persisted. Serves the
// GET /api/upstreams/blueprint endpoint so the create page consumes the same
// SerializedUpstreamRecord shape edit does — the front-end draft variable is
// uniform across create and edit, and no write-path invariants have to be
// satisfied. Field values are true blanks (empty strings, empty arrays),
// matching what an editor sees before typing anything or completing any
// OAuth flow.
export const blueprintUpstreamRecord = (kind: UpstreamProviderKind): UpstreamRecord => {
  const base = {
    id: '',
    name: '',
    enabled: false,
    sortOrder: 0,
    createdAt: '',
    updatedAt: '',
    flagOverrides: {} as FlagOverrides,
    disabledPublicModelIds: [] as string[],
    proxyFallbackList: [] as ProxyFallbackEntry[],
    modelPrefix: null,
  };
  switch (kind) {
  case 'copilot':
    return { ...base, kind, config: { githubToken: '', user: { login: '', avatar_url: '', name: null, id: 0 } }, state: null };
  case 'custom':
    return { ...base, kind, config: { baseUrl: '', authStyle: 'bearer', apiKey: '', endpoints: {}, modelsFetch: { enabled: false }, models: [] }, state: null };
  case 'azure':
    return { ...base, kind, config: { endpoint: '', apiKey: '', models: [] }, state: null };
  case 'codex':
    return { ...base, kind, config: { accounts: [] }, state: { accounts: [] } };
  case 'claude-code':
    return { ...base, kind, config: { accounts: [] }, state: { accounts: [] } };
  case 'ollama':
    return { ...base, kind, config: { baseUrl: '', apiKey: '', models: [] }, state: null };
  default: {
    const exhaustive: never = kind;
    throw new Error(`Unknown upstream provider kind: ${String(exhaustive)}`);
  }
  }
};
