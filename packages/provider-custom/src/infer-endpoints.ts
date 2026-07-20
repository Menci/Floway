// Tier 2 of custom-upstream endpoint detection: an id-pattern heuristic that
// runs when the upstream /models response did not publish an explicit kind. We
// tokenize the model id on common separators and match against a closed set of
// family tokens commonly associated with embedding catalogs:
//   - OpenAI:     text-embedding-3-large, text-embedding-ada-002 → embeddings
//   - Voyage:     voyage-3, voyage-multilingual-2 → embeddings
//   - Cohere:     embed-english-v3.0 → embeddings
//   - Mistral:    mistral-embed → embeddings
//   - Local:      bge-large-en, gte-large, e5-large, nomic-embed-text,
//                 mxbai-embed-large, UAE-Large-V1 → embeddings
//
// For image models we currently match only the `gpt-image-*` prefix
// (gpt-image-1, gpt-image-1.5, gpt-image-1-mini, gpt-image-2, including dated
// snapshots like gpt-image-2-2026-04-21). Other image families (dall-e, imagen,
// flux, sdxl, stable-diffusion) are intentionally NOT recognized — operators
// who run those against a custom upstream annotate the model explicitly.
// Audio transcription matches the standard OpenAI families (`whisper-*` and
// `*-transcribe-*`) after published `kind` metadata had the first chance to
// decide. OpenAI keeps the model field open while listing these canonical ids:
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36236-L36277
// Anything not matching returns null so the caller falls back to the upstream's
// configured endpoints (the chat case).

import type { ModelEndpoints } from '@floway-dev/protocols/common';

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

const AUDIO_TRANSCRIPTION_TOKENS = new Set(['whisper', 'transcribe']);

export const inferEndpointsFromModelId = (id: string): ModelEndpoints | null => {
  const lower = id.toLowerCase();
  if (lower.split(/[/_\-.]+/).some(token => EMBEDDING_TOKENS.has(token))) {
    return { embeddings: {} };
  }
  if (/^gpt-image(-|$)/.test(lower)) {
    return { imagesGenerations: {}, imagesEdits: {} };
  }
  if (lower.split(/[/_\-.]+/).some(token => AUDIO_TRANSCRIPTION_TOKENS.has(token))) {
    return { audioTranscriptions: {} };
  }
  return null;
};
