// Shared OpenAI streaming wire-shape predicates. Both `/v1/chat/completions`
// and `/v1/completions` emit the same SSE envelope: each content chunk has
// a `choices` array carrying `text` (or `delta`) plus an optional
// `finish_reason`, and when `stream_options.include_usage` is on, a final
// usage chunk lands carrying the totals. The gateway forces `include_usage`
// upstream for billing but strips that usage chunk from the forwarded
// stream when the client did not opt in, mirroring upstream's own behavior
// when the flag is off.
//
// OpenAI's usage-only terminal chunk carries `choices: []`. Floway also
// accepts non-empty structural placeholders, but never treats a choice with
// text, delta content, finish reason, logprobs, or unknown fields as usage-only.
// https://github.com/openai/openai-node/blob/3c261d3d5fa39dda1346bfb586edda5c227a5f37/src/resources/chat/completions/completions.ts#L1847-L1856
// https://github.com/openai/openai-node/blob/3c261d3d5fa39dda1346bfb586edda5c227a5f37/src/resources/chat/completions/completions.ts#L871-L897
// https://github.com/openai/openai-node/blob/3c261d3d5fa39dda1346bfb586edda5c227a5f37/src/resources/completions.ts#L91-L105

const OPENAI_USAGE_PLACEHOLDER_CHOICE_KEYS = new Set(['index', 'text', 'delta', 'finish_reason', 'logprobs']);

export const isOpenAIUsageOnlyEventShape = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false;
  const { choices, usage } = event as { choices?: unknown; usage?: unknown };
  if (typeof usage !== 'object' || usage === null || Array.isArray(usage)) return false;
  if (!Array.isArray(choices)) return false;
  // `every` over an empty array is true (the OpenAI shape).
  // A non-empty array passes only when every element is a structural
  // placeholder (no text, no delta keys, no finish_reason) — the
  // compatibility shape.
  return choices.every(choice => {
    if (typeof choice !== 'object' || choice === null || Array.isArray(choice)) return false;
    if (Object.keys(choice).some(key => !OPENAI_USAGE_PLACEHOLDER_CHOICE_KEYS.has(key))) return false;
    const { text, delta, finish_reason: finishReason, logprobs } = choice as { text?: unknown; delta?: unknown; finish_reason?: unknown; logprobs?: unknown };
    if (typeof text === 'string' && text.length > 0) return false;
    if (text !== undefined && text !== null && typeof text !== 'string') return false;
    if (finishReason !== undefined && finishReason !== null) return false;
    if (logprobs !== undefined && logprobs !== null) return false;
    if (delta !== undefined && delta !== null) {
      if (typeof delta !== 'object' || Array.isArray(delta)) return false;
      if (Object.keys(delta as object).length > 0) return false;
    }
    return true;
  });
};
