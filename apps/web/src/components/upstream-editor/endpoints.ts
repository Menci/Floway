import type { ModelEndpoints, ModelKind, RerankTarget } from '@floway-dev/protocols/common';

// The path each endpoint is addressed by, unversioned: the editor labels its
// checkboxes and its per-path overrides with the public route rather than with
// the key the config stores.
export const ENDPOINT_PATHS = {
  completions: '/completions',
  chatCompletions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  embeddings: '/embeddings',
  rerank: '/alpha/search',
  imagesGenerations: '/images/generations',
  imagesEdits: '/images/edits',
  audioTranscriptions: '/audio/transcriptions',
} as const satisfies Record<keyof ModelEndpoints, string>;

export const CHAT_ENDPOINT_KEYS = ['completions', 'chatCompletions', 'responses', 'messages'] as const satisfies readonly (keyof ModelEndpoints)[];
export const IMAGE_ENDPOINT_KEYS = ['imagesGenerations', 'imagesEdits'] as const satisfies readonly (keyof ModelEndpoints)[];

export const endpointOptionsFor = (
  keys: readonly (keyof ModelEndpoints)[],
): [keyof ModelEndpoints, string][] => keys.map(key => [key, ENDPOINT_PATHS[key]]);

// The rerank dialect a row starts on. `/alpha/search` speaks six mutually
// incompatible dialects and no upstream catalog names the one it implements,
// so a rerank row the gateway will accept has to start on some target and the
// operator confirms or changes it.
const INITIAL_RERANK_TARGET: RerankTarget = { protocol: 'cohere-v2' };

// Everything a model's kind decides about its own shape, for every place that
// puts a model into a kind: the discovered-model projection, the kind picker,
// and the auto-to-manual conversion. Chat and image models may be served by
// more than one endpoint, so a selection already made inside the family is
// kept and only an empty one falls back to the family default.
export const shapeForKind = (
  kind: ModelKind,
  current: { endpoints: ModelEndpoints; rerankTarget?: RerankTarget },
): { endpoints: ModelEndpoints; rerankTarget?: RerankTarget } => {
  if (kind === 'embedding') return { endpoints: { embeddings: {} } };
  if (kind === 'transcription') return { endpoints: { audioTranscriptions: {} } };
  if (kind === 'rerank') return { endpoints: { rerank: {} }, rerankTarget: current.rerankTarget ?? INITIAL_RERANK_TARGET };
  const family = kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS;
  const kept: ModelEndpoints = {};
  for (const key of family) if (current.endpoints[key]) kept[key] = current.endpoints[key];
  if (Object.keys(kept).length) return { endpoints: kept };
  return { endpoints: kind === 'image' ? { imagesGenerations: {}, imagesEdits: {} } : { chatCompletions: {} } };
};
