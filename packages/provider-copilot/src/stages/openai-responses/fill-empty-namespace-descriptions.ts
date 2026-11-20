import type { ResponsesFacts } from '../../chat-facts.ts';
import { defineStage, move } from '@floway-dev/pipeline';
import { mapOpenAIResponsesTools } from '@floway-dev/protocols/openai-responses';

/**
 * Some Copilot data planes reject empty namespace descriptions permitted by
 * the current OpenAI schema. Fill the permitted-empty text at the Copilot
 * boundary so the same request remains portable across those deployments.
 *
 * References:
 * - https://github.com/openai/openai-openapi/commit/466c74a42f51c02f1927bc666815251dc53845dc
 * - https://github.com/caozhiyuan/copilot-api/issues/345
 * - https://github.com/engineersamuel/copilot-proxy-rs/commit/1c23d7237bd1bd7c24045d0d426412851bfd57f6
 */

export const copilotOpenAIResponsesFillEmptyNamespaceDescriptions = defineStage<ResponsesFacts, ResponsesFacts, object, object>({
  name: 'copilotOpenAIResponsesFillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['request.provider.payload'], consumes: ['request.provider.payload'], provides: ['request.provider.payload'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    let payload = facts['request.provider.payload'];

    payload = mapOpenAIResponsesTools(payload, tool => tool.type === 'namespace' && tool.description === ''
      ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
      : tool);
    return move({ ...await next(move({ ...facts, 'request.provider.payload': payload })) });

  },
});
