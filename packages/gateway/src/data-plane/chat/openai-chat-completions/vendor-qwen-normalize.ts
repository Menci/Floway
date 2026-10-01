import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIChatCompletionsPayload } from '@floway-dev/protocols/openai-chat-completions';

/** Qwen says "no reasoning" with a top-level `enable_thinking: false` rather than with the
 *  canonical sentinel. Its response shape matches OpenAI for the fields the gateway reads, so
 *  there is nothing to do on the way back.
 *  https://www.alibabacloud.com/help/en/model-studio/deep-thinking */
export const vendorQwenNormalizeForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'vendorQwenNormalize',
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
      if (!facts['route.attempt'].flags.includes('vendor-qwen')) return facts;
      const payload = facts['request.chat.openaiChatCompletions'];
      if (payload.reasoning_effort !== 'none') return facts;
      const normalized: OpenAIChatCompletionsPayloadWithQwenThinking = {
        ...withoutKeys(payload, ['reasoning_effort']),
        enable_thinking: false,
      };
      return { ...facts, 'request.chat.openaiChatCompletions': move(normalized) };
    },
  })),
});

type OpenAIChatCompletionsPayloadWithQwenThinking = Omit<OpenAIChatCompletionsPayload, 'reasoning_effort'> & { enable_thinking: false };
