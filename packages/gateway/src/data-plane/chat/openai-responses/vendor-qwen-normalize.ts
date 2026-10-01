import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** Qwen says the same thing with a top-level `enable_thinking: false`.
 *  https://www.alibabacloud.com/help/en/model-studio/deep-thinking */
export const vendorQwenNormalizeForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'vendorQwenNormalize',
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
      if (!facts['route.attempt'].flags.includes('vendor-qwen')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      if (payload.reasoning?.effort !== 'none') return facts;
      const { reasoning, ...rest } = payload;
      const normalized: OpenAIResponsesPayloadWithQwenThinking = { ...rest, enable_thinking: false };
      return { ...facts, 'request.chat.openaiResponses': move(normalized) };
    },
  })),
});

type OpenAIResponsesPayloadWithQwenThinking = Omit<OpenAIResponsesPayload, 'reasoning'> & { enable_thinking: false };
