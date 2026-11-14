import { defineStage, move } from '@floway-dev/pipeline';
import { mapOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';
import type { ProviderModelFacts } from '@floway-dev/provider';

type Facts = { 'request.provider.payload': Omit<CanonicalOpenAIResponsesPayload, 'model'>; 'request.provider.model': ProviderModelFacts };

// Azure retains the former namespace-description minimum length.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
export const fillAzureNamespaceDescriptions = defineStage<Facts, Facts, object, object>({
  name: 'fillAzureNamespaceDescriptions',
  through: {
    request: { needs: ['request.provider.payload', 'request.provider.model'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const { model: _, ...payload } = mapOpenAIResponsesTools({ ...facts['request.provider.payload'], model: facts['request.provider.model'].id }, tool => tool.type === 'namespace' && tool.description === ''
      ? { ...tool, description: `Tools in the ${tool.name} namespace.` } : tool);
    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });
  },
});
