import { directFetcher, type ModelProvider, type ModelProviderInstance, type ProviderCandidate, type TelemetryModelIdentity, type UpstreamCallOptions, type UpstreamModel } from '@floway-dev/provider';

// No-op UpstreamCallOptions factory for tests calling provider methods
// directly: identity recordUpstreamLatency satisfies the contract without
// piping latency anywhere; the fetcher uses runtime fetch so
// `globalThis.fetch` spies still intercept; waitUntil drops the promise
// (the runtime would have absorbed it in production). Each invocation hands
// back a fresh `Headers` instance so tests that mutate the bag do not bleed
// state across cases.
export const noopUpstreamCallOptions = (): UpstreamCallOptions => ({
  fetcher: directFetcher,
  recordUpstreamLatency: <T>(promise: Promise<T>): Promise<T> => promise,
  waitUntil: () => {},
  headers: new Headers(),
});

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { chatCompletions: {}, responses: {}, messages: {} },
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key',
  cost: null,
};

// Auto-wrap a caller-provided mock impl so its returned value flows
// through the per-call `recordUpstreamLatency` hook. Direct vi.fn stubs
// would otherwise leave the contract uninvoked. Wrapping here keeps the
// spy's mock.calls intact (the inner fn still receives every arg,
// including opts).
const autoWrap = <T>(impl: T | undefined): T | undefined => {
  if (!impl) return undefined;
  const fn = impl as unknown as (...args: unknown[]) => Promise<unknown> | unknown;
  return ((...args: unknown[]) => {
    const opts = args[args.length - 1] as UpstreamCallOptions;
    return opts.recordUpstreamLatency(Promise.resolve(fn(...args)));
  }) as unknown as T;
};

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: overrides.getProvidedModels ?? (() => Promise.resolve([])),
  getPricingForModelKey: overrides.getPricingForModelKey ?? (() => null),
  callCompletions: autoWrap(overrides.callCompletions) ?? (() => Promise.reject(new Error('stubProvider.callCompletions was called'))),
  callChatCompletions: autoWrap(overrides.callChatCompletions) ?? (() => Promise.reject(new Error('stubProvider.callChatCompletions was called'))),
  callResponses: autoWrap(overrides.callResponses) ?? (() => Promise.reject(new Error('stubProvider.callResponses was called'))),
  callMessages: autoWrap(overrides.callMessages) ?? (() => Promise.reject(new Error('stubProvider.callMessages was called'))),
  callMessagesCountTokens: autoWrap(overrides.callMessagesCountTokens) ?? (() => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called'))),
  callEmbeddings: autoWrap(overrides.callEmbeddings) ?? (() => Promise.reject(new Error('stubProvider.callEmbeddings was called'))),
  callImagesGenerations: autoWrap(overrides.callImagesGenerations) ?? (() => Promise.reject(new Error('stubProvider.callImagesGenerations was called'))),
  callImagesEdits: autoWrap(overrides.callImagesEdits) ?? (() => Promise.reject(new Error('stubProvider.callImagesEdits was called'))),
});

export const stubProviderCandidate = (overrides: { model?: Partial<UpstreamModel>; provider?: ModelProviderInstance } = {}): ProviderCandidate => {
  const provider = overrides.provider ?? {
    upstream: 'test-upstream',
    providerKind: 'custom',
    name: 'Test Upstream',
    disabledPublicModelIds: [],
    modelPrefix: null,
    provider: stubProvider(),
    supportsResponsesItemReference: false,
  };
  return {
    provider,
    model: stubUpstreamModel(overrides.model ?? {}),
    fetcher: directFetcher,
  };
};
