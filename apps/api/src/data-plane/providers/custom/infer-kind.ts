// Tier 2 of custom-upstream embedding detection: id-pattern heuristic that
// runs when the upstream /models response did not emit an explicit `kind`.
// We tokenize the model id on common separators and match against a closed
// set of family tokens commonly associated with embedding catalogs:
//   - OpenAI:     text-embedding-3-large, text-embedding-ada-002 → 'embedding'
//   - Voyage:     voyage-3, voyage-multilingual-2 → 'embedding'
//   - Cohere:     embed-english-v3.0 → 'embedding'
//   - Mistral:    mistral-embed → 'embedding'
//   - Local:      bge-large-en, gte-large, e5-large, nomic-embed-text,
//                 mxbai-embed-large, UAE-Large-V1 → 'embedding'
//
// False positives are limited to models whose id contains one of these tokens
// despite being chat-capable (rare). Anything not matching falls back to
// 'chat' — the overwhelming default for /models catalogs in the wild.

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
  const tokens = id.toLowerCase().split(/[/_\-.]+/);
  return tokens.some(token => EMBEDDING_TOKENS.has(token)) ? 'embedding' : 'chat';
};
