// Protocol-level model endpoint types and their intrinsic kind projection.
// Provider projection and endpoint dispatch live in packages/gateway/src/data-plane/.

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured
// outputs) are orthogonal and modeled separately when needed.
//
// The initial vocabulary is seeded from Together AI's model type catalog,
// projected onto the endpoint families Floway routes. Together's list remains
// open-ended and uses different names for some families (`transcribe` rather
// than `transcription`, and `language` / `code` where Floway uses `chat`):
// https://github.com/togethercomputer/together-python/blob/b294927e2a3efdd79f95123c630d0520d13ba528/src/together/types/models.py#L10-L20
//
// Add a value here only when we actually route that endpoint family — do not
// pre-declare future capabilities.
export const MODEL_KINDS = ['chat', 'embedding', 'image', 'rerank', 'transcription'] as const;
export type ModelKind = typeof MODEL_KINDS[number];

export const parseModelKind = (value: unknown, label = 'model kind'): ModelKind => {
  if (typeof value === 'string' && (MODEL_KINDS as readonly string[]).includes(value)) return value as ModelKind;
  throw new Error(`${label} is invalid: ${JSON.stringify(value)}`);
};

// Structured endpoint map. A key being present means the model is served by
// that endpoint; its value object carries endpoint-specific metadata, if any.
// Sub-paths derived from a base endpoint
// (`/messages/count_tokens` from `messages`, `/responses/compact` from
// `responses`) are not modeled separately — presence of the base endpoint
// implies them.
export interface ModelEndpoints {
  // OpenAI text completions (`/v1/completions`). Passthrough only — we
  // never translate it to or from the three chat endpoints below, so it has
  // no endpoint-specific metadata. Orthogonal to `chatCompletions`: a model can
  // declare any non-empty subset.
  completions?: {};
  chatCompletions?: {};
  responses?: {};
  messages?: {};
  embeddings?: {};
  imagesGenerations?: {};
  imagesEdits?: {};
  audioTranscriptions?: {};
  rerank?: {};
}

// Names a single endpoint within ModelEndpoints — used where one endpoint is
// addressed by identity rather than as a presence map.
export type ModelEndpointKey = keyof ModelEndpoints;

// Derive the high-level model kind from the supported endpoints. `embeddings`
// implies embedding, `imagesGenerations`/`imagesEdits` implies image, `rerank`
// implies rerank, `audioTranscriptions` implies transcription, and generation
// protocols imply chat. Mixed endpoint sets use this first-match order for the
// single kind while dispatch continues to narrow on each endpoint's presence.
export const kindForEndpoints = (endpoints: ModelEndpoints): ModelKind => {
  if (endpoints.embeddings) return 'embedding';
  if (endpoints.imagesGenerations || endpoints.imagesEdits) return 'image';
  if (endpoints.rerank) return 'rerank';
  if (endpoints.audioTranscriptions) return 'transcription';
  return 'chat';
};
