import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/** The reasoning sentinel a forced tool choice needs. Gated by its flag, and the sentinel
 *  is the gateway's canonical form — putting it on the wire in a vendor's shape is the
 *  vendor normalizer's job, which is why this runs above them. */
export const disableReasoningOnForcedToolChoiceForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'disableReasoningOnForcedToolChoice',
  through: {
    request: {
      needs: ['request.chat.openaiChatCompletions', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiChatCompletions'],
    },
    response: { needs: ['response.chat.openaiChatCompletions'], consumes: [], provides: [] },
  },
  execute: transform<
    Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
    Chat<'request.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>,
    Chat<'response.chat.openaiChatCompletions'>
  >(() => ({
    request: facts => {
      if (!facts['route.attempt'].flags.includes('disable-reasoning-on-forced-tool-choice')) {
        return facts;
      }
      const payload = facts['request.chat.openaiChatCompletions'];
      if (!isForcedToolChoice(payload.tool_choice)) return facts;
      return { ...facts, 'request.chat.openaiChatCompletions': move({ ...payload, reasoning_effort: 'none' }) };
    },
  })),
});

/** `required`, or a named function. `auto` and `none` leave the model free to reason. */
const isForcedToolChoice = (choice: OpenAIChatCompletionsPayload['tool_choice']): boolean =>
  choice === 'required' || (typeof choice === 'object' && choice !== null);
