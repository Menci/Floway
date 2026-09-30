import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** The reasoning sentinel a forced tool choice needs. `required` or a named tool is forced;
 *  `auto` and `none` leave the model free to reason. The `reasoning` object is replaced
 *  rather than merged — a summary has no meaning once there is nothing to summarize — and
 *  the sentinel is the gateway's canonical form, which is why this runs above the vendor
 *  normalizers that put it on the wire in a vendor's shape. */
export const disableReasoningOnForcedToolChoiceForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'disableReasoningOnForcedToolChoice',
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
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.openaiResponses'];
      if (!isForcedOpenAIResponsesToolChoice(payload.tool_choice)) return facts;
      return { ...facts, 'request.chat.openaiResponses': move({ ...payload, reasoning: { effort: 'none' } }) };
    },
  })),
});

const isForcedOpenAIResponsesToolChoice = (choice: OpenAIResponsesPayload['tool_choice']): boolean => {
  if (choice === undefined || choice === null) return false;
  if (typeof choice === 'string') return choice === 'required';
  return true;
};
