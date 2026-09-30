import type { Chat } from '../facts.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';
import type { OpenAIResponsesPayload } from '@floway-dev/protocols/openai-responses';

/** DeepSeek says "no reasoning" with a top-level `thinking: { type: 'disabled' }` rather than
 *  with the canonical sentinel, so the sentinel is put into its wire form here — last among
 *  this chain's rewrites, because a vendor normalizer has the final say on the outbound body.
 *  https://api-docs.deepseek.com/zh-cn/guides/thinking_mode */
export const vendorDeepSeekNormalizeForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'vendorDeepSeekNormalize',
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
      if (!facts['route.attempt'].flags.includes('vendor-deepseek')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      if (payload.reasoning?.effort !== 'none') return facts;
      const { reasoning, ...rest } = payload;
      const normalized: OpenAIResponsesPayloadWithDeepSeekThinking = { ...rest, thinking: { type: 'disabled' } };
      return { ...facts, 'request.chat.openaiResponses': move(normalized) };
    },
  })),
});

/** Neither field is an OpenAI Responses field, so each is declared beside the vendor that reads it
 *  rather than widening the protocol's own request type. */
type OpenAIResponsesPayloadWithDeepSeekThinking = Omit<OpenAIResponsesPayload, 'reasoning'> & { thinking: { type: 'disabled' } };
