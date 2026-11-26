import { testFetcher } from './mock-fetch.ts';
import { type FlagId, type InternalModel, type PerformanceTelemetryContext, type ProviderInstance, type Provider, type ProviderModel, type ModelCandidate, type TelemetryModelIdentity, type AnthropicMessagesUpstreamCallOptions, type UpstreamCallOptions, identityWrapUpstreamCall } from '@floway-dev/provider';

// No-op UpstreamCallOptions factory for tests calling provider methods
// directly: the fetcher uses runtime fetch so `globalThis.fetch` spies still
// intercept; waitUntil drops the promise (the runtime would have absorbed it
// in production). The Headers bag is per-call so tests that mutate it do not
// bleed state across cases.
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

// Provider-side shape: what `getProvidedModels` returns and what every
// `provider.callXxx` takes at dispatch time. Interceptor boundary ctx types
// (Copilot / Codex / Claude Code) also use this shape, so interceptor tests
// that build a ctx by hand use `stubProviderModel` directly.
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

// Listing-side shape: an aggregated public catalog row.
export const stubInternalModel = (
  overrides: Partial<InternalModel> = {},
): InternalModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  ...overrides,
});

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

// An undefined override keeps the stub's default, so a test can forward its
// own optional handler without branching on whether it was supplied.
export const stubProvider = (overrides: { [K in keyof ProviderInstance]?: ProviderInstance[K] | undefined } = {}): ProviderInstance => ({
  runScheduledTask: overrides.runScheduledTask ?? (() => Promise.resolve()),
  getProvidedModels: overrides.getProvidedModels ?? (() => Promise.resolve([])),
  callAlphaSearch: overrides.callAlphaSearch ?? (() => Promise.reject(new Error('stubProvider.callAlphaSearch was called'))),
  callOpenAICompletions: overrides.callOpenAICompletions ?? (() => Promise.reject(new Error('stubProvider.callOpenAICompletions was called'))),
  callOpenAIChatCompletions: overrides.callOpenAIChatCompletions ?? (() => Promise.reject(new Error('stubProvider.callOpenAIChatCompletions was called'))),
  callOpenAIResponses: overrides.callOpenAIResponses ?? (() => Promise.reject(new Error('stubProvider.callOpenAIResponses was called'))),
  callAnthropicMessages: overrides.callAnthropicMessages ?? (() => Promise.reject(new Error('stubProvider.callAnthropicMessages was called'))),
  callAnthropicMessagesCountTokens: overrides.callAnthropicMessagesCountTokens ?? (() => Promise.reject(new Error('stubProvider.callAnthropicMessagesCountTokens was called'))),
  callGeminiGenerateContent: overrides.callGeminiGenerateContent ?? (() => Promise.reject(new Error('stubProvider.callGeminiGenerateContent was called'))),
  callGeminiGenerateContentCountTokens: overrides.callGeminiGenerateContentCountTokens ?? (() => Promise.reject(new Error('stubProvider.callGeminiGenerateContentCountTokens was called'))),
  callOpenAIEmbeddings: overrides.callOpenAIEmbeddings ?? (() => Promise.reject(new Error('stubProvider.callOpenAIEmbeddings was called'))),
  callOpenAIImagesGenerations: overrides.callOpenAIImagesGenerations ?? (() => Promise.reject(new Error('stubProvider.callOpenAIImagesGenerations was called'))),
  callOpenAIImagesEdits: overrides.callOpenAIImagesEdits ?? (() => Promise.reject(new Error('stubProvider.callOpenAIImagesEdits was called'))),
  callOpenAIAudioTranscriptions: overrides.callOpenAIAudioTranscriptions ?? (() => Promise.reject(new Error('stubProvider.callOpenAIAudioTranscriptions was called'))),
  callRerank: overrides.callRerank ?? (() => Promise.reject(new Error('stubProvider.callRerank was called'))),
  callDecision: overrides.callDecision ?? (() => Promise.reject(new Error('stubProvider.callDecision was called'))),
});

export const stubModelCandidate = (overrides: {
  model?: Partial<ProviderModel>;
  provider?: Provider;
  enabledFlags?: ReadonlySet<FlagId>;
  providerData?: unknown;
} = {}): ModelCandidate => {
  const provider = overrides.provider ?? {
    upstreamId: 'test-upstream',
    kind: 'custom',
    name: 'Test Upstream',
    inboundHeaderAllowlist: [],
    instance: stubProvider(),
  };
  const modelOverrides = overrides.model ?? {};
  const id = modelOverrides.id ?? 'test-model';
  const model = stubProviderModel({
    id,
    upstreamModelId: modelOverrides.upstreamModelId ?? id,
    ...modelOverrides,
    ...(overrides.enabledFlags !== undefined ? { enabledFlags: overrides.enabledFlags } : {}),
    ...(overrides.providerData !== undefined ? { providerData: overrides.providerData } : {}),
  });
  return {
    provider,
    model,
    fetcher: testFetcher,
  };
};
