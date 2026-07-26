import type { MessagesPayload, MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

// OpenAI `service_tier: 'fast'` maps to Anthropic `speed: 'fast'`; all other
// defined values pass through as `service_tier` so upstream-owned literals
// remain opaque in both directions.
// https://docs.claude.com/en/build-with-claude/fast-mode
export const messagesServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<MessagesPayload> =>
  serviceTier === 'fast'
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

export const openAIServiceTierFromMessagesUsage = (usage: Pick<MessagesUsageSnapshot, 'speed' | 'service_tier'>): string | undefined =>
  usage.speed === 'fast' ? 'fast' : usage.service_tier;
