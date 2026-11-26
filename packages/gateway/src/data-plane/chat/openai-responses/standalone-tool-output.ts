import { openAIResponsesInputError } from './errors.ts';
import { standaloneToolOutputContent } from './items/standalone-tool-output-content.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { tryCatchChatServeFailure, type InputErrorDetails } from '../shared/errors.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// Translators need a paired call for tool outputs. Codex also sends standalone
// outputs as external context, such as a goal's objective.
// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const lowerOpenAIResponsesStandaloneToolOutput = defineStage({
  name: 'openaiResponses.lower-standalone-tool-output',
  through: {
    request: { needs: ['request.openaiResponses', 'provider.model'], provides: ['request.openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['response.http', 'response.openaiResponses'] },
  async execute(facts, scope) {
    const model = facts['provider.model'];
    const payload = facts['request.openaiResponses'];
    if (model.endpoints.openaiResponses !== undefined && !model.enabledFlags.includes('openai-responses-standalone-tool-output-shim')) return await scope.next(facts);
    const lowered = lowerOpenAIResponsesStandaloneOutputInput(payload.input);
    if ('failure' in lowered) return openAIResponsesInputError(lowered.failure);
    if (lowered.input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, 'request.openaiResponses': { ...payload, input: lowered.input } });
  },
});

export const lowerOpenAIResponsesStandaloneOutputInput = (input: CanonicalOpenAIResponsesInputItem[]) => {
  if (!input.some(item => item.type === 'function_call_output' && item.call_id == null)) return { input };
  try {
    return {
      input: input.map((item, index): CanonicalOpenAIResponsesInputItem => item.type === 'function_call_output' && item.call_id == null
        ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) }
        : item),
    };
  } catch (error) {
    const failure = tryCatchChatServeFailure<InputErrorDetails & { kind: 'invalid-input' }>(error);
    if (failure === null) throw error;
    return { failure };
  }
};
