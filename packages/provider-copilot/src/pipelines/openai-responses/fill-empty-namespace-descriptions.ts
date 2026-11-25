import { defineCopilotStage } from '../facts.ts';
import { move, transform } from '@floway-dev/pipeline';
import { mapOpenAIResponsesTools, type CanonicalOpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

// Copilot rejects empty namespace descriptions in Codex tool declarations.
// https://github.com/caozhiyuan/copilot-api/issues/345
// https://github.com/engineersamuel/copilot-proxy-rs/commit/1c23d7237bd1bd7c24045d0d426412851bfd57f6
export const fillEmptyNamespaceDescriptions = defineCopilotStage({
  name: 'copilot.openaiResponses.fillEmptyNamespaceDescriptions',
  through: {
    request: { needs: ['request.openaiResponses'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  execute: transform(() => ({
    request(facts) {
      const payload: typeof facts['request.openaiResponses'] & Pick<CanonicalOpenAIResponsesPayload, 'tools'> = facts['request.openaiResponses'];
      const { input, tools } = mapOpenAIResponsesTools({
        model: payload.model,
        input: payload.input,
        ...(payload.tools !== undefined && { tools: payload.tools }),
      }, tool => tool.type === 'namespace' && tool.description === ''
        ? { ...tool, description: `Tools in the ${tool.name} namespace.` }
        : tool);
      const next = { ...payload, input, ...(tools !== undefined && { tools }) };
      return { ...facts, 'request.openaiResponses': move(next) };
    },
  })),
});
