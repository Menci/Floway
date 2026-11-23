import { rewriteChatRequest } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsPayloadEx } from '@floway-dev/protocols/openai-chat-completions';

export const stripPromptCacheKey = rewriteChatRequest(
  'stripPromptCacheKey', 'request.openaiChatCompletions', (payload: OpenAIChatCompletionsPayloadEx, { providerModel }) => {
    if (!providerModel.enabledFlags.includes('strip-prompt-cache-key') || payload.prompt_cache_key === undefined) return payload;
    const { prompt_cache_key: _stripped, ...rest } = payload;
    return rest;
  },
);
