import { testFetcher } from './mock-fetch.ts';
import { type FlagId, type InternalModel, type PerformanceTelemetryContext, type ProviderInstance, type Provider, type ProviderModel, type ModelCandidate, type TelemetryModelIdentity, type AnthropicMessagesUpstreamCallOptions, type UpstreamCallOptions, identityWrapUpstreamCall } from '@floway-dev/provider';

// The runtime fetch spy remains visible behind replayable bodies, and each fixture owns its headers.
export const noopUpstreamCallOptions = (overrides: Partial<UpstreamCallOptions> = {}): UpstreamCallOptions => ({
  fetcher: testFetcher,
  waitUntil: () => {},
  headers: new Headers(),
  wrapUpstreamCall: identityWrapUpstreamCall,
  ...overrides,
});

export const noopAnthropicMessagesUpstreamCallOptions = (overrides: Partial<AnthropicMessagesUpstreamCallOptions> = {}): AnthropicMessagesUpstreamCallOptions => ({
  ...noopUpstreamCallOptions(overrides),
  anthropicBeta: [],
  ...overrides,
});

// Catalog metadata is normalized into portable immutable facts at pipeline entry.
export const stubProviderModel = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: 'test-model',
  upstreamModelId: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  enabledFlags: new Set<FlagId>(),
  ...overrides,
});

// Gateway-side shape: what the resolver hands the attempt layer. Defaults
// seed `providerModels` with a single entry keyed on the given upstream id —
// the entry mirrors the outer metadata so tests that resolve
// `providerModelOf(candidate)` see a coherent shape without extra ceremony.
// Callers that need a specific per-upstream shape pass `providerModels`
// explicitly. Every stub is a real-row `InternalModel`; alias-row fixtures
// belong on the alias-listing side and construct their `InternalModel`
// directly with `aliasedFrom`.
export const stubInternalModel = (
  overrides: Partial<Omit<InternalModel, 'aliasedFrom' | 'providerModels'>> & { readonly providerModels?: Record<string, ProviderModel> } = {},
  upstream = 'test-upstream',
): InternalModel => {
  const base = {
    id: overrides.id ?? 'test-model',
    limits: overrides.limits ?? {},
    kind: overrides.kind ?? 'chat',
    endpoints: overrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  } as const;
  return {
    ...base,
    ...overrides,
    providerModels: overrides.providerModels ?? { [upstream]: stubProviderModel(base) },
  };
};

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  pricing: null,
};

export const mockPerfTelemetryContext = (overrides: Partial<PerformanceTelemetryContext> = {}): PerformanceTelemetryContext => ({
  keyId: 'test-key',
  model: 'test-model',
  upstream: 'test-upstream',
  operation: 'chat',
  runtimeLocation: 'SJC',
  ...overrides,
});

export const stubProvider = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
  getProvidedModels: overrides.getProvidedModels ?? (() => Promise.resolve([])),
});

// Stitches together a candidate whose `model.providerModels` map carries an
// entry under the wired provider's upstream id — that's what
// `providerModelOf(candidate)` resolves to at dispatch time. The
// `enabledFlags` / `providerData` shortcuts populate that ProviderModel
// directly — the common case for stage tests that just need a flag set
// for the resolver's own upstream key. Any `model.providerModels` supplied
// through `overrides.model` replaces both the default entry and those
// shortcuts wholesale.
export const stubModelCandidate = (overrides: {
  model?: Partial<Omit<InternalModel, 'aliasedFrom' | 'providerModels'>> & { readonly providerModels?: Record<string, ProviderModel> };
  provider?: Provider;
  enabledFlags?: ReadonlySet<FlagId>;
  providerData?: unknown;
} = {}): ModelCandidate => {
  const provider = overrides.provider ?? {
    upstreamId: 'test-upstream',
    kind: 'custom',
    name: 'Test Upstream',
    inboundHeaderAllowlist: [],
    disabledPublicModelIds: [],
    modelPrefix: null,
    modelsCache: null,
    pipelines: {},
    instance: stubProvider(),
  };
  const modelOverrides = overrides.model ?? {};
  const outerMeta = {
    id: modelOverrides.id ?? 'test-model',
    limits: modelOverrides.limits ?? {},
    kind: modelOverrides.kind ?? 'chat',
    endpoints: modelOverrides.endpoints ?? { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  } as const;
  const providerModel = stubProviderModel({
    id: outerMeta.id,
    upstreamModelId: outerMeta.id,
    limits: outerMeta.limits,
    kind: outerMeta.kind,
    endpoints: outerMeta.endpoints,
    enabledFlags: overrides.enabledFlags ?? new Set<FlagId>(),
    ...(modelOverrides.pricing !== undefined ? { pricing: modelOverrides.pricing } : {}),
    ...(overrides.providerData !== undefined ? { providerData: overrides.providerData } : {}),
  });
  return {
    provider,
    model: stubInternalModel({
      ...modelOverrides,
      providerModels: modelOverrides.providerModels ?? { [provider.upstreamId]: providerModel },
    }),
    fetcher: testFetcher,
  };
};
