import { asJsonObject, readJsonNumber } from '../../../../shared/json-helpers.ts';
import { mapProtocolEvents, rewriteChatFrames } from '../../shared/rewrite-stage.ts';
import type { OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';

// Kimi's flat cached_tokens field denotes OpenAI's prompt_tokens_details.cached_tokens.
// https://platform.kimi.com/docs/api/chat
const normalizeKimiUsage = (chunk: OpenAIChatCompletionsStreamEvent): OpenAIChatCompletionsStreamEvent => {
  const { usage } = chunk;
  if (!usage || !asJsonObject(usage)) return chunk;
  const { cached_tokens: cached, ...remaining } = usage as typeof usage & { readonly cached_tokens?: unknown };
  const cacheRead = readJsonNumber(cached);
  if (cacheRead === null) return chunk;
  return {
    ...chunk,
    usage: {
      ...remaining,
      prompt_tokens_details: { ...asJsonObject(usage.prompt_tokens_details), cached_tokens: cacheRead },
    },
  };
};

export const normalizeKimiResponse = rewriteChatFrames(
  'normalizeKimiResponse', 'response.openaiChatCompletions', ({ 'route.candidate': { providerModel } }) => providerModel.enabledFlags.includes('vendor-kimi')
    ? mapProtocolEvents(normalizeKimiUsage)
    : undefined,
);
