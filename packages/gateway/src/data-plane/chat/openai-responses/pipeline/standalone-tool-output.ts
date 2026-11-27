import { openAIResponsesLocalError } from './local-error.ts';
import { defineStage } from '../../pipeline/facts.ts';
import { OpenAIResponsesInvalidInputError } from '../items/invalid-input.ts';
import { standaloneToolOutputContent } from '../items/standalone-tool-output-content.ts';
import type { CanonicalOpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

// https://github.com/openai/codex/blob/8011b92bc82d4cc1b6dc3f35c0cd28768c797c97/codex-rs/context-fragments/src/additional_context.rs#L35-L46
// https://github.com/openai/codex/issues/42088
export const lowerOpenAIResponsesStandaloneOutputInput = (input: CanonicalOpenAIResponsesInputItem[]) => {
  if (!input.some(item => item.type === 'function_call_output' && item.call_id == null)) return { input };
  try {
    return {
      input: input.map((item, index): CanonicalOpenAIResponsesInputItem =>
        item.type === 'function_call_output' && item.call_id == null ? { type: 'message', role: 'user', content: standaloneToolOutputContent(item, index) } : item),
    };
  } catch (error) {
    if (!(error instanceof OpenAIResponsesInvalidInputError)) throw error;
    return { failure: error };
  }
};

export const lowerOpenAIResponsesStandaloneToolOutput = defineStage({
  name: 'openaiResponses.lower-standalone-tool-output',
  through: {
    request: { needs: ['openaiResponses', 'model', 'chat.target'], provides: ['openaiResponses'], consumes: [] },
    response: { needs: [], provides: [], consumes: [] },
  },
  return: { provides: ['http', 'openaiResponses'] },
  async execute(facts, scope) {
    if (facts['chat.target'] === 'openaiResponses' && !facts.model.enabledFlags.includes('openai-responses-standalone-tool-output-shim')) return await scope.next(facts);
    const payload = facts.openaiResponses;
    const lowered = lowerOpenAIResponsesStandaloneOutputInput(payload.input);
    if ('failure' in lowered) return openAIResponsesLocalError(400, lowered.failure.message, lowered.failure);
    if (lowered.input === payload.input) return await scope.next(facts);
    return await scope.next({ ...facts, openaiResponses: { ...payload, input: lowered.input } });
  },
});
