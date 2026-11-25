import type { ProviderModel } from '@floway-dev/provider';

export const stubProviderModel = (overrides: Partial<ProviderModel> = {}): ProviderModel => ({
  id: 'test-model',
  upstreamModelId: 'test-model',
  limits: {},
  kind: 'chat',
  endpoints: { openaiChatCompletions: {}, openaiResponses: {}, anthropicMessages: {} },
  opaqueBlobCompatibilityScope: { bindToUpstream: true },
  enabledFlags: new Set(),
  ...overrides,
});
