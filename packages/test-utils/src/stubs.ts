import type { FlagId, InternalModel, PerformanceTelemetryContext, ProviderModel } from '@floway-dev/provider';

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

// The default real catalog row contributes one provider model on the chosen upstream.
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

export const mockPerfTelemetryContext = (overrides: Partial<PerformanceTelemetryContext> = {}): PerformanceTelemetryContext => ({
  keyId: 'test-key',
  model: 'test-model',
  upstream: 'test-upstream',
  operation: 'chat',
  runtimeLocation: 'SJC',
  ...overrides,
});
