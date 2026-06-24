// Shared OpenAI streaming wire-shape predicates. Both `/v1/chat/completions`
// and `/v1/completions` emit the same SSE envelope: each chunk has a
// `choices` array, and when `stream_options.include_usage` is on, a final
// usage-only chunk lands with `choices: []` plus a `usage` block carrying
// the totals. The gateway forces `include_usage` upstream for billing but
// strips that usage-only chunk from the forwarded stream when the client
// did not opt in, mirroring upstream's own behavior when the flag is off.

export const isOpenAIUsageOnlyEventShape = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false;
  const { choices, usage } = event as { choices?: unknown; usage?: unknown };
  return Array.isArray(choices) && choices.length === 0 && usage !== undefined && usage !== null;
};
