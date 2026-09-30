import type { Chat } from '../facts.ts';
import { withoutKeys } from '../shared/structural.ts';
import { defineStage, transform, move } from '@floway-dev/pipeline';

/** Drops a field the upstream would reject as an unknown argument. It runs above the vendor
 *  normalizers so each of them sees the already-stripped canonical payload. */
export const stripPromptCacheKeyForOpenAIChatCompletions = defineStage<
  Chat<'request.chat.openaiChatCompletions' | 'route.attempt'>,
  Chat<'request.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>,
  Chat<'response.chat.openaiChatCompletions'>
>({
  name: 'stripPromptCacheKey',
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
      if (!facts['route.attempt'].flags.includes('strip-prompt-cache-key')) return facts;
      const payload = facts['request.chat.openaiChatCompletions'];
      const stripped = withoutKeys(payload, ['prompt_cache_key']);
      return stripped === payload ? facts : { ...facts, 'request.chat.openaiChatCompletions': move(stripped) };
    },
  })),
});
