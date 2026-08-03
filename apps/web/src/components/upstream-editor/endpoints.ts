import type { ModelEndpoints } from '@floway-dev/protocols/common';

// The path each endpoint is addressed by, unversioned: the editor labels its
// checkboxes and its per-path overrides with the public route rather than with
// the key the config stores.
export const ENDPOINT_PATHS: Record<keyof ModelEndpoints, string> = {
  completions: '/completions',
  chatCompletions: '/chat/completions',
  responses: '/responses',
  messages: '/messages',
  embeddings: '/embeddings',
  rerank: '/alpha/search',
  imagesGenerations: '/images/generations',
  imagesEdits: '/images/edits',
  audioTranscriptions: '/audio/transcriptions',
};

export const CHAT_ENDPOINT_KEYS = ['completions', 'chatCompletions', 'responses', 'messages'] as const satisfies readonly (keyof ModelEndpoints)[];
export const IMAGE_ENDPOINT_KEYS = ['imagesGenerations', 'imagesEdits'] as const satisfies readonly (keyof ModelEndpoints)[];

export const endpointOptionsFor = (
  keys: readonly (keyof ModelEndpoints)[],
): [keyof ModelEndpoints, string][] => keys.map(key => [key, ENDPOINT_PATHS[key]]);
