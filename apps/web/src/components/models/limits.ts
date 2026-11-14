import type { ModelKind, PublicModelLimits } from '@floway-dev/protocols/browser';

export type ModelLimitKey = keyof PublicModelLimits;

// A prompt budget exists only to split a window with an output budget: Copilot
// derives a window as `max_prompt_tokens + max_output_tokens`
// (packages/provider-copilot/src/model-selection.ts), and OpenAI's own model
// page states `922,000` maximum input plus `128,000` maximum output for a
// `1,050,000` context window.
//
// Only a chat turn has an output side to split off. Everything else states the
// window alone: a decision request has no generated stream to cap (Copilot
// ignores `max_output_tokens` and friends on `/v1/decisions`, reports
// `output_tokens: 0` with `total_tokens == input_tokens`, and accepts 921,858
// input tokens before rejecting with 400), and embedding, rerank, and
// transcription responses carry no generated stream either. An image model has
// no token window at all.
const LIMIT_KEYS_BY_KIND: Readonly<Record<ModelKind, readonly ModelLimitKey[]>> = {
  chat: ['max_context_window_tokens', 'max_prompt_tokens', 'max_output_tokens'],
  embedding: ['max_context_window_tokens'],
  rerank: ['max_context_window_tokens'],
  transcription: ['max_context_window_tokens'],
  decision: ['max_context_window_tokens'],
  image: [],
};

export const limitKeysForKind = (kind: ModelKind): readonly ModelLimitKey[] => LIMIT_KEYS_BY_KIND[kind];

// Drop the limits a kind cannot state, so switching a row's kind never keeps a
// value the form no longer shows.
export const pruneLimitsForKind = (
  limits: PublicModelLimits | undefined,
  kind: ModelKind,
): PublicModelLimits | undefined => {
  if (limits === undefined) return undefined;
  const kept: PublicModelLimits = {};
  for (const key of limitKeysForKind(kind)) {
    const value = limits[key];
    if (value !== undefined) kept[key] = value;
  }
  return Object.keys(kept).length === 0 ? undefined : kept;
};
