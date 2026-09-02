import { FAST_SERVICE_TIER, isFastServiceTier } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesUsageSnapshot } from '@floway-dev/protocols/messages';

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
export const messagesServiceTierFieldsFromOpenAI = (serviceTier: string | null | undefined): Partial<MessagesPayload> =>
  isFastServiceTier(serviceTier)
    ? { speed: 'fast' }
    : serviceTier != null
      ? { service_tier: serviceTier }
      : {};

// Anthropic's `speed: 'fast'` surfaces as the OpenAI accelerated lane; every
// other Anthropic `service_tier` passes through directly. The near-homonym
// `openAIServiceTierFromMessages` in `shared/messages-via/service-tier.ts`
// encodes the opposite rule for a non-`fast` `speed`: on the request side a
// present-but-not-fast `speed` drops the tier, while a usage snapshot still
// falls back to the reported `service_tier`.
export const openAIServiceTierFromMessagesUsage = (usage: Pick<MessagesUsageSnapshot, 'speed' | 'service_tier'>): string | undefined =>
  usage.speed === 'fast' ? FAST_SERVICE_TIER : usage.service_tier;
