import { factSpace, move, transform } from '@floway-dev/pipeline';
import { mapOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<Pick<GatewayFacts, 'request.openaiResponses'>>();

// Azure still enforces the former namespace-description minLength.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
export const fillEmptyNamespaceDescriptions = defineStage({
  name: 'azure.fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request: facts => ({
      ...facts,
      'request.openaiResponses': move(mapOpenAIResponsesTools(facts['request.openaiResponses'], tool => tool.type === 'namespace' && tool.description === ''
        ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
        : tool)),
    }),
  })),
});
