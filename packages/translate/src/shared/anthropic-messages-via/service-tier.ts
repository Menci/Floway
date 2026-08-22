import type { AnthropicMessagesPayload } from '@floway-dev/protocols/anthropic-messages';

// `speed: 'fast'` maps to OpenAI `service_tier: 'fast'`; other non-fast
// `speed` values have no OpenAI equivalent and are dropped. When `speed` is
// absent, Anthropic's own `service_tier` passes through verbatim.
// https://docs.claude.com/en/build-with-claude/fast-mode
export const openAIServiceTierFromAnthropicMessages = (payload: Pick<AnthropicMessagesPayload, 'speed' | 'service_tier'>): string | undefined =>
  payload.speed === 'fast' ? 'fast' : payload.speed === undefined ? payload.service_tier : undefined;
