import { factSpace, transform } from '@floway-dev/pipeline';
import type { CanonicalOpenAIResponsesInputItem, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';
import type { GatewayFacts } from '@floway-dev/provider';

const { defineStage } = factSpace<GatewayFacts>();

// Azure still enforces the former namespace description minimum length.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
const fillDescriptions = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
  const updated = tools.map(tool => tool.type === 'namespace' && tool.description === ''
    ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
    : tool);
  return updated.some((tool, index) => tool !== tools[index]) ? updated : tools;
};

export const fillInputDescriptions = (input: CanonicalOpenAIResponsesInputItem[]): CanonicalOpenAIResponsesInputItem[] => {
  const updated = input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const tools = fillDescriptions(item.tools);
    return tools === item.tools ? item : { ...item, tools };
  });
  return updated.some((item, index) => item !== input[index]) ? updated : input;
};

export const fillEmptyNamespaceDescriptions = defineStage({
  name: 'azure.openaiResponses.fill-empty-namespace-descriptions',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload = facts['request.openaiResponses'];
      const input = fillInputDescriptions(payload.input);
      const tools = Array.isArray(payload.tools) ? fillDescriptions(payload.tools) : payload.tools;
      if (input === payload.input && tools === payload.tools) return facts;
      return {
        ...facts,
        'request.openaiResponses': { ...payload, input, ...(tools !== undefined && { tools }) },
      };
    },
  })),
});
