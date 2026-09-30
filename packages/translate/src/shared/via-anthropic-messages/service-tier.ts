import type { AnthropicMessagesPayload, AnthropicMessagesUsageSnapshot } from '@floway-dev/protocols/anthropic-messages';
import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';

// Both OpenAI spellings of the accelerated lane map to Anthropic's `speed:
// 'fast'`; all other defined values pass through as `service_tier` so
// upstream-owned literals stay opaque in both directions.
//
// This does mean an OpenAI-shaped `priority` can no longer surface as
// Anthropic's own `usage.service_tier: 'priority'`. The two are different
// things — Anthropic's priority tier is provisioned capacity on the account,
// OpenAI's is a per-request lane — and only one of them can ever originate
// from an OpenAI-shaped upstream, which is the lane.
// https://docs.claude.com/en/build-with-claude/fast-mode
// https://platform.openai.com/docs/guides/fast-mode
export const anthropicMessagesServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<AnthropicMessagesPayload> =>
  isFastServiceTier(serviceTier)
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

// Anthropic's `speed: 'fast'` surfaces as the OpenAI accelerated lane; every
// other Anthropic `service_tier` passes through directly. The near-homonym
// `openAIServiceTierFromAnthropicMessages` in `shared/anthropic-messages-via/service-tier.ts`
// encodes the opposite rule for a non-`fast` `speed`: on the request side a
// present-but-not-fast `speed` drops the tier, while a usage snapshot still
// falls back to the reported `service_tier`.
export const openAIServiceTierFromAnthropicMessagesUsage = (usage: Pick<AnthropicMessagesUsageSnapshot, 'speed' | 'service_tier'>): string | undefined =>
  usage.speed === 'fast' ? FAST_SERVICE_TIER : usage.service_tier;
