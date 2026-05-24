// Per-model pricing in USD per million tokens, aligned with the sst/models.dev
// `Cost` schema (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Extensions follow that schema's field names (`reasoning`, `input_audio`,
// `output_audio`, etc.) when they are added.
export interface ModelPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured
// outputs) are orthogonal and modeled separately when needed.
//
// Convention borrowed from Together AI's `type` field on /v1/models, which
// chooses a single string enum because each model id in practice maps to
// one endpoint family. We renamed `type` to `kind` to avoid colliding with
// Anthropic's `type: 'model'` object discriminator already on PublicModel.
//
// Together AI's live /v1/models is known to emit at least these values:
//
//   chat        — instruction-tuned chat models (vision LLMs are also `chat`)
//   language    — base / text-completion models
//   code        — code-completion models
//   image       — text-to-image AND image-to-image (one type, switched by
//                 presence of an input image in the request)
//   embedding   — vector embedding models
//   moderation  — Llama-Guard-style classifiers (routed via /v1/completions)
//   rerank      — query/document re-rankers
//   audio       — text-to-speech models
//   transcribe  — speech-to-text models
//   video       — text-to-video models
//
// This list is open-ended and has grown reactively: Together's published
// OpenAPI schema still lists only the first 7, but the live API has
// emitted at least `audio`, `transcribe`, and `video` in production, each
// landing in the official together-python SDK only after response
// validation broke downstream (PRs #241, #341, #383). New values may
// appear at any time.
//
// We adopt the same vocabulary because the names are already established
// in the ecosystem. Add a value here only when we actually route that
// endpoint family — do not pre-declare for future capabilities.
export type ModelKind = 'chat' | 'embedding' | 'image';

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
