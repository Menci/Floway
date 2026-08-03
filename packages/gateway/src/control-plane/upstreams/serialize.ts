import type {
  BlueprintSerializedUpstreamRecord,
  FullSerializedUpstreamRecord,
  RedactedSerializedUpstreamRecord,
} from './types.ts';
import { flagDefaultsForKind } from '../../data-plane/providers/registry.ts';
import type { FlagOverrides, ProxyFallbackEntry, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { assertAzureUpstreamRecord } from '@floway-dev/provider-azure';
import { assertClaudeCodeUpstreamRecord, assertClaudeCodeUpstreamState } from '@floway-dev/provider-claude-code';
import { assertCodexUpstreamRecord, assertCodexUpstreamState } from '@floway-dev/provider-codex';
import { assertCopilotUpstreamRecord, assertCopilotUpstreamState } from '@floway-dev/provider-copilot';
import { assertCustomUpstreamRecord } from '@floway-dev/provider-custom';
import { assertOllamaUpstreamRecord } from '@floway-dev/provider-ollama';

export type { FullSerializedUpstreamRecord } from './types.ts';

const clone = <T>(value: T): T => structuredClone(value);
const hasSecret = (value: string | undefined | null): boolean => typeof value === 'string' && value.length > 0;

const serializeBase = (upstream: UpstreamRecord) => ({
  id: upstream.id,
  name: upstream.name,
  enabled: upstream.enabled,
  sort_order: upstream.sortOrder,
  created_at: upstream.createdAt,
  updated_at: upstream.updatedAt,
  flag_overrides: { ...upstream.flagOverrides },
  flag_defaults: flagDefaultsForKind(upstream.kind),
  disabled_public_model_ids: [...upstream.disabledPublicModelIds],
  proxy_fallback_list: upstream.proxyFallbackList.map(entry => entry.colos === undefined
    ? { id: entry.id }
    : { id: entry.id, colos: [...entry.colos] }),
  model_prefix: upstream.modelPrefix === null ? null : clone(upstream.modelPrefix),
  hue: upstream.hue,
});

const stateless = (upstream: UpstreamRecord): null => {
  if (upstream.state !== null) {
    throw new Error(`Upstream ${upstream.id} (${upstream.kind}) must not carry runtime state`);
  }
  return null;
};

export const upstreamRecordToJson = (upstream: UpstreamRecord): RedactedSerializedUpstreamRecord => {
  const base = serializeBase(upstream);
  switch (upstream.kind) {
  case 'custom': {
    const { config } = assertCustomUpstreamRecord(upstream);
    return {
      ...base,
      kind: 'custom',
      config: {
        baseUrl: config.baseUrl,
        authStyle: config.authStyle,
        endpoints: clone(config.endpoints),
        ...(config.pathOverrides !== undefined ? { pathOverrides: clone(config.pathOverrides) } : {}),
        modelsFetch: clone(config.modelsFetch),
        models: clone(config.models),
        apiKeySet: config.authStyle !== 'none' && hasSecret(config.apiKey),
      },
      state: stateless(upstream),
    };
  }
  case 'azure': {
    const { config } = assertAzureUpstreamRecord(upstream);
    return {
      ...base,
      kind: 'azure',
      config: { endpoint: config.endpoint, models: clone(config.models), apiKeySet: hasSecret(config.apiKey) },
      state: stateless(upstream),
    };
  }
  case 'copilot': {
    const { config } = assertCopilotUpstreamRecord(upstream);
    let state: Extract<RedactedSerializedUpstreamRecord, { kind: 'copilot' }>['state'] = null;
    if (upstream.state !== null) {
      assertCopilotUpstreamState(upstream.state);
      state = {
        copilotToken: upstream.state.copilotToken === null ? null : { baseUrl: upstream.state.copilotToken.baseUrl },
        // The whole snapshot is upstream-owned numbers with no secret in it, so
        // it round-trips verbatim. Rows written before the slot existed carry
        // no key at all -- the same absent-is-null boundary the state reader
        // applies.
        quotaSnapshot: upstream.state.quotaSnapshot ?? null,
      };
    }
    return {
      ...base,
      kind: 'copilot',
      config: { user: clone(config.user), githubTokenSet: hasSecret(config.githubToken) },
      state,
    };
  }
  case 'codex': {
    assertCodexUpstreamRecord(upstream);
    assertCodexUpstreamState(upstream.state);
    const state = {
      accounts: upstream.state.accounts.map(account => ({
        chatgptAccountId: account.chatgptAccountId,
        state: account.state,
        ...(account.state_message !== undefined ? { state_message: account.state_message } : {}),
        state_updated_at: account.state_updated_at,
        refresh_token_set: hasSecret(account.refresh_token),
      })),
    };
    return { ...base, kind: 'codex', config: clone(upstream.config), state };
  }
  case 'claude-code': {
    assertClaudeCodeUpstreamRecord(upstream);
    assertClaudeCodeUpstreamState(upstream.state);
    const state = {
      accounts: upstream.state.accounts.map(account => ({
        accountUuid: account.accountUuid,
        tokenKind: account.tokenKind,
        state: account.state,
        ...(account.stateMessage !== undefined ? { stateMessage: account.stateMessage } : {}),
        stateUpdatedAt: account.stateUpdatedAt,
        refreshTokenSet: hasSecret(account.refreshToken),
        accessToken: account.accessToken === null
          ? null
          : { expiresAt: account.accessToken.expiresAt, refreshedAt: account.accessToken.refreshedAt },
        quotaSnapshot: clone(account.quotaSnapshot),
        usageProbeSnapshot: clone(account.usageProbeSnapshot),
      })),
    };
    return { ...base, kind: 'claude-code', config: clone(upstream.config), state };
  }
  case 'ollama': {
    const { config } = assertOllamaUpstreamRecord(upstream);
    return {
      ...base,
      kind: 'ollama',
      config: { baseUrl: config.baseUrl, models: clone(config.models), apiKeySet: hasSecret(config.apiKey) },
      state: stateless(upstream),
    };
  }
  }
};

export const upstreamRecordToFullJson = (upstream: UpstreamRecord): FullSerializedUpstreamRecord => {
  const base = serializeBase(upstream);
  switch (upstream.kind) {
  case 'custom': {
    const record = assertCustomUpstreamRecord(upstream);
    return { ...base, kind: 'custom', config: clone(record.config), state: stateless(upstream) };
  }
  case 'azure': {
    const record = assertAzureUpstreamRecord(upstream);
    return { ...base, kind: 'azure', config: clone(record.config), state: stateless(upstream) };
  }
  case 'copilot': {
    const record = assertCopilotUpstreamRecord(upstream);
    if (record.state !== null) assertCopilotUpstreamState(record.state);
    return { ...base, kind: 'copilot', config: clone(record.config), state: clone(record.state) };
  }
  case 'codex': {
    assertCodexUpstreamRecord(upstream);
    assertCodexUpstreamState(upstream.state);
    return { ...base, kind: 'codex', config: clone(upstream.config), state: clone(upstream.state) };
  }
  case 'claude-code': {
    assertClaudeCodeUpstreamRecord(upstream);
    assertClaudeCodeUpstreamState(upstream.state);
    return { ...base, kind: 'claude-code', config: clone(upstream.config), state: clone(upstream.state) };
  }
  case 'ollama': {
    const record = assertOllamaUpstreamRecord(upstream);
    return { ...base, kind: 'ollama', config: clone(record.config), state: stateless(upstream) };
  }
  }
};

const blueprintBase = (kind: UpstreamProviderKind) => ({
  id: '',
  name: '',
  enabled: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  flag_overrides: {} as FlagOverrides,
  flag_defaults: flagDefaultsForKind(kind),
  disabled_public_model_ids: [] as string[],
  proxy_fallback_list: [] as ProxyFallbackEntry[],
  model_prefix: null,
});

export const blueprintUpstreamRecord = (kind: UpstreamProviderKind): BlueprintSerializedUpstreamRecord => {
  const base = blueprintBase(kind);
  switch (kind) {
  case 'copilot':
    return { ...base, kind, config: { githubToken: '', user: { login: '', avatar_url: '', name: null, id: 0 } }, state: null };
  case 'custom':
    // A custom upstream starts on the shape most of them have: an
    // OpenAI-compatible chat endpoint whose model catalog the upstream itself
    // publishes. The blueprint is the create form's opening record, so this is
    // the only place a new upstream's starting values are decided.
    return { ...base, kind, config: { baseUrl: '', authStyle: 'bearer', apiKey: '', endpoints: { chatCompletions: {} }, modelsFetch: { enabled: true }, models: [] }, state: null };
  case 'azure':
    return { ...base, kind, config: { endpoint: '', apiKey: '', models: [] }, state: null };
  case 'codex':
    return { ...base, kind, config: { accounts: [] }, state: { accounts: [] } };
  case 'claude-code':
    return { ...base, kind, config: { accounts: [] }, state: { accounts: [] } };
  case 'ollama':
    return { ...base, kind, config: { baseUrl: '', apiKey: '', models: [] }, state: null };
  }
};
