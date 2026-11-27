import { expandShimCompactionItems } from './compaction.ts';
import { defineStage } from './facts.ts';
import { normalizeAssistantInputText } from '../../chat/openai-responses/items/normalize-assistant-content.ts';
import { lowerOpenAIResponsesAgentInput } from '../../chat/openai-responses/pipeline/agent-message.ts';
import { openAIResponsesLocalError } from '../../chat/openai-responses/pipeline/local-error.ts';
import { lowerOpenAIResponsesStandaloneOutputInput } from '../../chat/openai-responses/pipeline/standalone-tool-output.ts';
import type { InputErrorDetails } from '../../chat/shared/errors.ts';

export const prepareNativeOpenAIResponsesCompact = defineStage({
  name: 'openaiResponsesCompact.prepare-native-request',
  through: {
    request: { needs: ['openaiResponsesCompact', 'model'], provides: ['openaiResponsesCompact'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponsesCompact'] },
  async execute(facts, scope) {
    const { model, openaiResponsesCompact } = facts;
    const flags = model.enabledFlags;
    const failure = (problem: InputErrorDetails) => {
      const { http, openaiResponses } = openAIResponsesLocalError(400, problem.message, {
        ...(problem.param === undefined ? {} : { param: problem.param }),
        ...(problem.code === undefined ? {} : { code: problem.code }),
      });
      return { http, openaiResponsesCompact: openaiResponses };
    };

    let input = normalizeAssistantInputText(openaiResponsesCompact.input);
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
    const request = expandShimCompactionItems({ ...openaiResponsesCompact, input });
    return await scope.next({ ...facts, openaiResponsesCompact: request });
  },
});
