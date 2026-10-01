import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

/** Drops a field the upstream would reject as an unknown argument. It runs above the vendor
 *  normalizers so each of them sees the already-stripped canonical payload. */
export const stripPromptCacheKeyForOpenAIResponses = defineStage<
  Chat<'request.chat.openaiResponses' | 'route.attempt'>,
  Chat<'request.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>,
  Chat<'response.chat.openaiResponses'>
>({
  name: 'stripPromptCacheKey',
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
      if (!facts['route.attempt'].flags.includes('strip-prompt-cache-key')) return facts;
      const payload = facts['request.chat.openaiResponses'];
      const stripped = withoutKeys(payload, ['prompt_cache_key']);
      return stripped === payload ? facts : { ...facts, 'request.chat.openaiResponses': move(stripped) };
    },
  })),
});
