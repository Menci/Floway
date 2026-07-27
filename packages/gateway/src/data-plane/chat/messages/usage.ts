import { tokenUsage } from '../../shared/telemetry/usage.ts';
import { billableServiceTier, type ProtocolFrame } from '@floway-dev/protocols/common';
import { mergeMessagesUsageSnapshot, messagesUsageSnapshot, splitMessagesCacheCreationTokens } from '@floway-dev/protocols/messages';
import type { MessagesMessageDeltaEvent, MessagesStreamEvent, MessagesUsage } from '@floway-dev/protocols/messages';

type MessagesUsageLike = MessagesUsage | NonNullable<MessagesMessageDeltaEvent['usage']>;

// Anthropic already reports disjoint token counts: input_tokens excludes the
// cache figures. Map them straight onto the billing metrics without
// summing. When the upstream emits the `cache_creation` sub-object
// (extended-cache-ttl-2025-04-11), split the per-TTL counts onto the 5m and
// 1h metrics; the flat `cache_creation_input_tokens` is the sum and is
// only consulted when the sub-object is absent.
//
// Response usage carries two server-stamped tier fields: `speed` (fast mode)
// and `service_tier` (capacity assignment). Fast mode is documented as
// unavailable with Priority Tier and the Batch API, so at most one
// non-`standard` value lands on a single response — prefer `speed` first
// (the only multi-x override today) then fall through to `service_tier`.
// `standard` on either side collapses to null so per-tier rows aggregate
// with base; unknown values flow through verbatim so a future Anthropic
// release does not silently bill at base.
//   * https://docs.claude.com/en/build-with-claude/fast-mode
//   * https://docs.claude.com/en/api/service-tiers
export const tokenUsageFromMessagesUsage = (usage: MessagesUsageLike) => {
  const { cacheWrite, cacheWrite1h } = splitMessagesCacheCreationTokens(usage);
  const tier = billableServiceTier(usage.speed) ?? billableServiceTier(usage.service_tier);
  return tokenUsage({
    input: usage.input_tokens ?? 0,
    input_cache_read: usage.cache_read_input_tokens ?? 0,
    input_cache_write: cacheWrite,
    input_cache_write_1h: cacheWrite1h,
    output: usage.output_tokens,
    tier,
  });
};

export const createMessagesStreamUsageState = () => ({
  raw: messagesUsageSnapshot(),
  current: tokenUsage({}),
});

export type MessagesStreamUsageState = ReturnType<typeof createMessagesStreamUsageState>;

// Returns a snapshot of the running usage on every frame that revises it, not
// only on `message_stop`, so the respond layer can checkpoint billing state
// into `SourceStreamState.usage` as the stream progresses. A client disconnect
// that races the terminal frame would otherwise discard the last
// `message_delta`'s output count. Each call returns a fresh object so the
// snapshot stored in `SourceStreamState.usage` does not silently mutate when
// the next delta lands.
export const tokenUsageFromMessagesFrame = (frame: ProtocolFrame<MessagesStreamEvent>, state: MessagesStreamUsageState) => {
  if (frame.type !== 'event') return null;
  const { event } = frame;
  if (event.type === 'message_start') {
    state.raw = messagesUsageSnapshot(event.message.usage);
    state.current = tokenUsageFromMessagesUsage(state.raw);
    return { ...state.current };
  }
  if (event.type === 'message_delta' && event.usage) {
    state.raw = mergeMessagesUsageSnapshot(state.raw, event.usage);
    state.current = tokenUsageFromMessagesUsage(state.raw);
    return { ...state.current };
  }
  return event.type === 'message_stop' ? { ...state.current } : null;
};
