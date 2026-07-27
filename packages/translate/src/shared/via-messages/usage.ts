import { splitMessagesCacheCreationTokens, type MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

export interface InclusiveMessagesInputUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h: number;
  inclusiveInput: number;
}

// Anthropic's `input_tokens` excludes cache reads and cache creation, while
// OpenAI and Gemini input totals include those buckets.
export const inclusiveMessagesInputUsage = (usage: MessagesUsageSnapshot): InclusiveMessagesInputUsage => {
  const { cacheWrite, cacheWrite1h } = splitMessagesCacheCreationTokens(usage);
  const input = usage.input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  return {
    input,
    cacheRead,
    cacheWrite,
    cacheWrite1h,
    inclusiveInput: input + cacheRead + cacheWrite + cacheWrite1h,
  };
};
