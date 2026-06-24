// Shared OpenAI streaming wire-shape predicates. Both `/v1/chat/completions`
// and `/v1/completions` emit the same SSE envelope: each content chunk has
// a `choices` array carrying `text` (or `delta`) plus an optional
// `finish_reason`, and when `stream_options.include_usage` is on, a final
// usage chunk lands carrying the totals. The gateway forces `include_usage`
// upstream for billing but strips that usage chunk from the forwarded
// stream when the client did not opt in, mirroring upstream's own behavior
// when the flag is off.
//
// The usage chunk's `choices` shape varies in the wild. Vanilla OpenAI and
// vanilla vLLM emit `choices: []`. Vendor vLLM forks (e.g. the Zhipu/GLM
// fork) emit `choices: [{ index: 0 }]` — a placeholder element with no
// content fields. Some upstreams (Ollama) repeat a zeroed usage on every
// content chunk, leaving the real numbers for a final `choices: []`
// chunk. The predicate therefore identifies the usage chunk by "carries
// usage" + "no choice element has any actual content", which matches the
// LiteLLM / One-API / New-API consensus.

export const isOpenAIUsageOnlyEventShape = (event: unknown): boolean => {
  if (typeof event !== 'object' || event === null) return false;
  const { choices, usage } = event as { choices?: unknown; usage?: unknown };
  if (usage === undefined || usage === null) return false;
  if (!Array.isArray(choices)) return false;
  // `every` over an empty array is true (the OpenAI / vanilla-vLLM shape).
  // A non-empty array passes only when every element is a structural
  // placeholder (no text, no delta keys, no finish_reason) — the
  // Zhipu/GLM vendor-fork shape.
  return choices.every(choice => {
    if (typeof choice !== 'object' || choice === null) return false;
    const { text, delta, finish_reason: finishReason } = choice as { text?: unknown; delta?: unknown; finish_reason?: unknown };
    if (typeof text === 'string' && text.length > 0) return false;
    if (finishReason !== undefined && finishReason !== null) return false;
    if (delta !== undefined && delta !== null) {
      if (typeof delta !== 'object') return false;
      if (Object.keys(delta as object).length > 0) return false;
    }
    return true;
  });
};
