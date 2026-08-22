import type { AnthropicMessagesPayload, AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';

// OpenAI `service_tier: 'fast'` maps to Anthropic `speed: 'fast'`; all other
// defined values pass through as `service_tier` so upstream-owned literals
// remain opaque in both directions.
// https://docs.claude.com/en/build-with-claude/fast-mode
export const anthropicMessagesServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<AnthropicMessagesPayload> =>
  serviceTier === 'fast'
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

// Anthropic's `speed: 'fast'` surfaces as OpenAI `service_tier: 'fast'`; every
// other Anthropic `service_tier` passes through directly. The near-homonym
// `openAIServiceTierFromAnthropicMessages` in `shared/anthropic-messages-via/service-tier.ts`
// encodes the opposite rule for a non-`fast` `speed`: on the request side a
// present-but-not-fast `speed` drops the tier, while a usage snapshot still
// falls back to the reported `service_tier`.
export const openAIServiceTierFromAnthropicMessagesUsage = (usage: Pick<AnthropicMessagesUsageSnapshot, 'speed' | 'service_tier'>): string | undefined =>
  usage.speed === 'fast' ? 'fast' : usage.service_tier;
