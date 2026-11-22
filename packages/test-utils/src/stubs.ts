import type {
  FlagId,
  InternalModel,
  PerformanceTelemetryContext,
  ProviderInstance,
  ProviderModel,
  TelemetryModelIdentity,
} from '@floway-dev/provider';

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
  runScheduledTask: overrides.runScheduledTask ?? (() => Promise.resolve()),
  getProvidedModels: overrides.getProvidedModels ?? (() => Promise.resolve([])),
});
