import { directFetcher, type FlagId, type InternalModel, type PerformanceTelemetryContext, type ProviderInstance, type Provider, type ProviderModel, type ModelCandidate, type TelemetryModelIdentity, type UpstreamCallOptions, identityWrapUpstreamCall } from '@floway-dev/provider';

// No-op UpstreamCallOptions factory for tests calling provider methods
// directly: the fetcher uses runtime fetch so `globalThis.fetch` spies still
// intercept; waitUntil drops the promise (the runtime would have absorbed it
// in production). The Headers bag is per-call so tests that mutate it do not
// bleed state across cases.
export const noopUpstreamCallOptions = (overrides: Partial<UpstreamCallOptions> = {}): UpstreamCallOptions => ({
  fetcher: directFetcher,
  waitUntil: () => {},
  headers: new Headers(),
  wrapUpstreamCall: identityWrapUpstreamCall,
  ...overrides,
});

// Provider-side shape: what `getProvidedModels` returns and what every
// `provider.callXxx` takes at dispatch time. Interceptor boundary ctx types
// (Copilot / Codex / Claude Code) also use this shape, so interceptor tests
// that build a ctx by hand use `stubProviderModel` directly.
export const stubProviderModel = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {}, responses: {}, messages: {} },
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
    endpoints: overrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} },
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
  callAlphaSearch: overrides.callAlphaSearch ?? (() => Promise.reject(new Error('stubProvider.callAlphaSearch was called'))),
  callCompletions: overrides.callCompletions ?? (() => Promise.reject(new Error('stubProvider.callCompletions was called'))),
  callChatCompletions: overrides.callChatCompletions ?? (() => Promise.reject(new Error('stubProvider.callChatCompletions was called'))),
  callResponses: overrides.callResponses ?? (() => Promise.reject(new Error('stubProvider.callResponses was called'))),
  callMessages: overrides.callMessages ?? (() => Promise.reject(new Error('stubProvider.callMessages was called'))),
  callMessagesCountTokens: overrides.callMessagesCountTokens ?? (() => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called'))),
  callEmbeddings: overrides.callEmbeddings ?? (() => Promise.reject(new Error('stubProvider.callEmbeddings was called'))),
  callImagesGenerations: overrides.callImagesGenerations ?? (() => Promise.reject(new Error('stubProvider.callImagesGenerations was called'))),
  callImagesEdits: overrides.callImagesEdits ?? (() => Promise.reject(new Error('stubProvider.callImagesEdits was called'))),
  callRerank: overrides.callRerank ?? (() => Promise.reject(new Error('stubProvider.callRerank was called'))),
});

// Stitches together a candidate whose `model.providerModels` map carries an
// entry under the wired provider's upstream id — that's what
// `providerModelOf(candidate)` resolves to at dispatch time. The
// `enabledFlags` / `providerData` shortcuts populate that ProviderModel
// directly — the common case for interceptor tests that just need a flag set
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
    upstream: 'test-upstream',
    kind: 'custom',
    name: 'Test Upstream',
    disabledPublicModelIds: [],
    modelPrefix: null,
    instance: stubProvider(),
  };
  const modelOverrides = overrides.model ?? {};
  const outerMeta = {
    id: modelOverrides.id ?? 'test-model',
    limits: modelOverrides.limits ?? {},
    kind: modelOverrides.kind ?? 'chat',
    endpoints: modelOverrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} },
  } as const;
  const providerModel = stubProviderModel({
    id: outerMeta.id,
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
      providerModels: modelOverrides.providerModels ?? { [provider.upstream]: providerModel },
    }),
    fetcher: directFetcher,
  };
};
