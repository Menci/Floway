import type { InputErrorDetails } from '../../shared/errors.ts';
import { lowerOpenAIResponsesAgentInput } from '../agent-message.ts';
import { expandShimCompactionItems } from '../compaction.ts';
import { openAIResponsesInputError } from '../errors.ts';
import { normalizeAssistantInputText } from '../items/normalize-assistant-content.ts';
import { defineOpenAIResponsesStage } from '../pipeline-facts.ts';
import { lowerOpenAIResponsesStandaloneOutputInput } from '../standalone-tool-output.ts';

export const openAIResponsesCompactInputShims = defineOpenAIResponsesStage({
  name: 'openaiResponsesCompact.input-shims',
  through: {
    request: { needs: ['request.openaiResponsesCompact', 'provider.model'], provides: ['request.openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponsesCompact'] },
  async execute(facts, scope) {
    const request = facts['request.openaiResponsesCompact'];
    const flags = facts['provider.model'].enabledFlags;
    const failure = (problem: InputErrorDetails) => {
      const { 'response.http': http, 'response.openaiResponses': outcome } = openAIResponsesInputError(problem);
      return { 'response.http': http, 'response.openaiResponsesCompact': outcome };
    };

    let input = normalizeAssistantInputText(request.input);
    if (flags.includes('openai-responses-agent-message-shim')) {
      const lowered = lowerOpenAIResponsesAgentInput(input);
      if ('failure' in lowered) return failure(lowered.failure);
      input = lowered.input;
    }
    if (flags.includes('openai-responses-standalone-tool-output-shim')) {
      const lowered = lowerOpenAIResponsesStandaloneOutputInput(input);
      if ('failure' in lowered) return failure(lowered.failure);
      input = lowered.input;
    }
    const expanded = expandShimCompactionItems(input === request.input ? request : { ...request, input });
    return await scope.next({ ...facts, 'request.openaiResponsesCompact': expanded });
  },
});
