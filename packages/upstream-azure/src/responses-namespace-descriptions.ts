import type { CanonicalOpenAIResponsesInputItem, CanonicalOpenAIResponsesPayload, OpenAIResponsesTool } from '@floway-dev/protocols/openai-responses';

// Azure still enforces the former namespace description minimum length.
// https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// https://github.com/openai/codex/issues/37380
const fillDescriptions = (tools: OpenAIResponsesTool[]): OpenAIResponsesTool[] => {
  const updated = tools.map(tool => tool.type === 'namespace' && tool.description === ''
    ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
    : tool);
  return updated.some((tool, index) => tool !== tools[index]) ? updated : tools;
};

export const fillAzureResponsesInputNamespaceDescriptions = (input: CanonicalOpenAIResponsesInputItem[]): CanonicalOpenAIResponsesInputItem[] => {
  const updated = input.map(item => {
    if (item.type !== 'additional_tools' && item.type !== 'tool_search_output') return item;
    const tools = fillDescriptions(item.tools);
    return tools === item.tools ? item : { ...item, tools };
  });
  return updated.some((item, index) => item !== input[index]) ? updated : input;
};

export const fillAzureResponsesNamespaceDescriptions = (payload: CanonicalOpenAIResponsesPayload): CanonicalOpenAIResponsesPayload => {
  const input = fillAzureResponsesInputNamespaceDescriptions(payload.input);
  const tools = Array.isArray(payload.tools) ? fillDescriptions(payload.tools) : payload.tools;
  if (input === payload.input && tools === payload.tools) return payload;
  return { ...payload, input, ...(tools === undefined ? {} : { tools }) };
};
