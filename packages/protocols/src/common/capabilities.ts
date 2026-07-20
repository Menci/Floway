// Protocol-level model capability types and their intrinsic kind projection.
// Provider projection and endpoint dispatch live in packages/gateway/src/data-plane/.

import type { ModelKind } from './models.ts';

// Structured per-endpoint capability map. A key being present means the model
// is served by that endpoint; its value object carries that endpoint's
// sub-capabilities, if any. Sub-paths derived from a base endpoint
// (`/messages/count_tokens` from `messages`, `/responses/compact` from
// `responses`) are not modeled separately — presence of the base endpoint
// implies them.
export interface ModelEndpoints {
  // OpenAI text completions (`/v1/completions`). Passthrough only — we
  // never translate it to or from the three chat endpoints below, so it has
  // no sub-capability surface. Orthogonal to `chatCompletions`: a model can
  // declare any non-empty subset.
  completions?: {};
  chatCompletions?: {};
  responses?: {};
  messages?: {};
  embeddings?: {};
  imagesGenerations?: {};
  imagesEdits?: {};
  rerank?: {};
}

// Names a single endpoint within ModelEndpoints — used where one endpoint is
// addressed by identity rather than as a presence map.
export type ModelEndpointKey = keyof ModelEndpoints;

// Derive the high-level model kind from the supported endpoints. Each model
// belongs to exactly one kind. `embeddings` implies embedding,
// `imagesGenerations`/`imagesEdits` implies image, `rerank` implies rerank,
// and the generation protocols imply chat.
// Mixed endpoint sets (e.g. a model tagged with both `embeddings` and
// `chatCompletions`) are configuration errors; the first matching branch wins.
// `kind` is a pure projection of `endpoints`; the dispatch layer never reads it.
export const kindForEndpoints = (endpoints: ModelEndpoints): ModelKind => {
  if (endpoints.embeddings) return 'embedding';
  if (endpoints.imagesGenerations || endpoints.imagesEdits) return 'image';
  if (endpoints.rerank) return 'rerank';
  return 'chat';
};
