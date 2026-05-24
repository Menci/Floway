import type { TelemetryModelIdentity } from '../../../../../repo/types.ts';
import type { ModelProvider, UpstreamModel } from '../../../../providers/types.ts';
import type { ChatCompletionsInvocation, RequestContext } from '../../../interceptors.ts';
import type { ChatCompletionsPayload } from '@copilot-gateway/protocols/chat-completions';

export const stubUpstreamModel = (overrides: Partial<UpstreamModel> = {}): UpstreamModel => ({
  id: 'test-model',
  limits: {},
  kind: 'chat',
  upstreamEndpoints: ['chat_completions', 'responses', 'messages'],
  enabledFlags: new Set<string>(),
  ...overrides,
});

export const stubProvider = (overrides: Partial<ModelProvider> = {}): ModelProvider => ({
  getProvidedModels: () => Promise.resolve([]),
  getPricingForModelKey: () => null,
  callChatCompletions: () => Promise.reject(new Error('stubProvider.callChatCompletions was called')),
  callResponses: () => Promise.reject(new Error('stubProvider.callResponses was called')),
  callMessages: () => Promise.reject(new Error('stubProvider.callMessages was called')),
  callMessagesCountTokens: () => Promise.reject(new Error('stubProvider.callMessagesCountTokens was called')),
  callEmbeddings: () => Promise.reject(new Error('stubProvider.callEmbeddings was called')),
  callImagesGenerations: () => Promise.reject(new Error('stubProvider.callImagesGenerations was called')),
  callImagesEdits: () => Promise.reject(new Error('stubProvider.callImagesEdits was called')),
  ...overrides,
});

export const testTelemetryModelIdentity: TelemetryModelIdentity = {
  model: 'test-model',
  upstream: 'test-upstream',
  modelKey: 'test-model-key', cost: null,
};

export const chatCompletionsInvocation = (payload: ChatCompletionsPayload, enabledFlags: ReadonlySet<string> = new Set()): ChatCompletionsInvocation => ({
  sourceApi: 'chat-completions',
  targetApi: 'chat-completions',
  model: payload.model,
  upstream: 'test-upstream',
  upstreamModel: stubUpstreamModel(),
  provider: stubProvider(),
  enabledFlags,
  payload,
});

export const stubRequestContext: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};
