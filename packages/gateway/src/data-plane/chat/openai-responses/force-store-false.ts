import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

/** Asks a stateful upstream to answer statelessly, gated by `openai-responses-store-false`.
 *  The flag is the operator's statement of what the upstream tolerates: Copilot refuses a
 *  stored turn, and Ollama ignores `previous_response_id`. */
export const forceStoreFalseForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'forceStoreFalse',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: ['response.chat.openaiResponses'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiResponses' | 'route.attempt'>,
    Chat<'request.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>,
    Chat<'response.chat.openaiResponses'>
  >(() => ({
    request: facts => {
      const payload = facts['request.chat.openaiResponses'];
      if (!facts['route.attempt'].flags.includes('openai-responses-store-false') || payload.store === false) return facts;
      return { ...facts, 'request.chat.openaiResponses': move({ ...payload, store: false }) };
    },
  })),
});
