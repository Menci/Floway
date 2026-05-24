// Tier 2 of custom-upstream kind detection: id-pattern heuristic that
// runs when the upstream /models response did not emit an explicit
// `kind`. We tokenize the model id on common separators and match
// against a closed set of family tokens commonly associated with
// embedding catalogs:
//   - OpenAI:     text-embedding-3-large, text-embedding-ada-002 → 'embedding'
//   - Voyage:     voyage-3, voyage-multilingual-2 → 'embedding'
//   - Cohere:     embed-english-v3.0 → 'embedding'
//   - Mistral:    mistral-embed → 'embedding'
//   - Local:      bge-large-en, gte-large, e5-large, nomic-embed-text,
//                 mxbai-embed-large, UAE-Large-V1 → 'embedding'
//
// For image models we currently match only the `gpt-image-*` prefix
// (gpt-image-1, gpt-image-1.5, gpt-image-1-mini, gpt-image-2, including
// dated snapshots like gpt-image-2-2026-04-21). Other image families
// (dall-e, imagen, flux, sdxl, stable-diffusion) are intentionally NOT
// recognized — operators who run those models against a custom upstream
// will need the planned per-model kind annotation. Anything not matching
// falls back to 'chat'.

import type { ModelKind } from '@floway-dev/protocols/common';

const EMBEDDING_TOKENS = new Set([
  'embed',
  'embedding',
  'embeddings',
  'bge',
  'e5',
  'gte',
  'uae',
  'nomic',
  'voyage',
]);

export const inferKindFromModelId = (id: string): ModelKind => {
  const lower = id.toLowerCase();
  if (lower.split(/[/_\-.]+/).some(token => EMBEDDING_TOKENS.has(token))) {
    return 'embedding';
  }
  if (/^gpt-image(-|$)/.test(lower)) {
    return 'image';
  }
  return 'chat';
};
