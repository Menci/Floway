import { mapOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';
import type { CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Azure OpenAI still enforces the former namespace-description minLength while
// current OpenAI Responses permits an empty required string. We supply a
// deterministic model-facing description only on Azure-bound requests.
//
// References:
// - https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
// - https://github.com/openai/codex/issues/37380
export const fillEmptyNamespaceDescriptionsPayload = (
  payload: Omit<CanonicalOpenAIResponsesPayload, 'model'>,
): Omit<CanonicalOpenAIResponsesPayload, 'model'> => mapOpenAIResponsesTools(
  payload as CanonicalOpenAIResponsesPayload,
  tool => tool.type === 'namespace' && tool.description === ''
    ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
    : tool,
);
