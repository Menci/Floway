import { directFetcher, type InternalModel, type ProviderInstance, type Provider, type ProviderModel, type ModelCandidate, type TelemetryModelIdentity, type UpstreamCallOptions } from '@floway-dev/provider';

// No-op UpstreamCallOptions factory for tests calling provider methods
// directly: identity recordUpstreamLatency satisfies the contract without
// piping latency anywhere; the fetcher uses runtime fetch so
// `globalThis.fetch` spies still intercept; waitUntil drops the promise
// (the runtime would have absorbed it in production). Each invocation hands
// back a fresh `Headers` instance so tests that mutate the bag do not bleed
// state across cases.
export const noopUpstreamCallOptions = (overrides: Partial<UpstreamCallOptions> = {}): UpstreamCallOptions => ({
  fetcher: directFetcher,
  recordUpstreamLatency: <T>(promise: Promise<T>): Promise<T> => promise,
  waitUntil: () => {},
  headers: new Headers(),
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
  enabledFlags: new Set<string>(),
  ...overrides,
});

// Gateway-side shape: what the resolver hands the attempt layer. Defaults
// seed `providerModels` with a single entry keyed on the given upstream id —
// the entry mirrors the outer metadata so tests that resolve
// `providerModelOf(candidate)` see a coherent shape without extra ceremony.
// Callers that need a specific per-upstream shape pass `providerModels`
// explicitly.
export const stubInternalModel = (overrides: Partial<InternalModel> = {}, upstream = 'test-upstream'): InternalModel => {
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

export const stubProvider = (overrides: Partial<ProviderInstance> = {}): ProviderInstance => ({
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

// Stitches together a candidate whose `model.providerModels` map carries an
// entry under the wired provider's upstream id — that's what
// `providerModelOf(candidate)` resolves to at dispatch time. The
// `enabledFlags` / `providerData` shortcuts populate that ProviderModel
// directly — the common case for interceptor tests that just need a flag set
// for the resolver's own upstream key. Any `model.providerModels` supplied
// through `overrides.model` replaces both the default entry and those
// shortcuts wholesale.
export const stubModelCandidate = (overrides: {
  model?: Partial<InternalModel>;
  provider?: Provider;
  enabledFlags?: ReadonlySet<string>;
  providerData?: unknown;
} = {}): ModelCandidate => {
  const provider = overrides.provider ?? {
    upstream: 'test-upstream',
    kind: 'custom',
    name: 'Test Upstream',
    disabledPublicModelIds: [],
    modelPrefix: null,
    instance: stubProvider(),
    supportsResponsesItemReference: false,
  };
  const modelOverrides = overrides.model ?? {};
  const outerMeta: Partial<InternalModel> = {
    id: modelOverrides.id ?? 'test-model',
    limits: modelOverrides.limits ?? {},
    kind: modelOverrides.kind ?? 'chat',
    endpoints: modelOverrides.endpoints ?? { chatCompletions: {}, responses: {}, messages: {} },
  };
  const providerModel = stubProviderModel({
    id: outerMeta.id,
    limits: outerMeta.limits,
    kind: outerMeta.kind,
    endpoints: outerMeta.endpoints,
    enabledFlags: overrides.enabledFlags ?? new Set<string>(),
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
