import type { MessagesPayload } from '@floway-dev/protocols/messages';

// `speed: 'fast'` maps to OpenAI `service_tier: 'fast'`; other non-fast
// `speed` values have no OpenAI equivalent and are dropped. When `speed` is
// absent, Anthropic's own `service_tier` passes through verbatim.
// https://docs.claude.com/en/build-with-claude/fast-mode
export const openAIServiceTierFromMessages = (payload: Pick<MessagesPayload, 'speed' | 'service_tier'>): string | undefined =>
  payload.speed === 'fast' ? 'fast' : payload.speed === undefined ? payload.service_tier : undefined;
