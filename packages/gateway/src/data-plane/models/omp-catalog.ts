// Tailor Floway's public models catalog for oh-my-pi (omp) agent discovery.
//
// When omp discovers models (`discovery.type: openai-models-list`), it requests
// `GET <baseUrl>/models` sending `headers: { User-Agent: floway-omp/1 }`.
// Unlike generic callers, omp's discovery parser reads de-facto OpenAI fields:
// - Context window: `max_model_len`, else `context_length`, else
//   `limits.max_input_tokens + limits.max_output_tokens`.
// - Output cap: `limits.max_output_tokens`.
// - Image input: `input` / `input_modalities` / `architecture.input_modalities`.
// - Dedicated task: single output modality `embedding`/`embeddings` ->
//   openai-embeddings, `image` -> openai-images; anything else is treated as chat.
//
// Reference:
// https://github.com/can1357/oh-my-pi/blob/4ef97c8/packages/coding-agent/src/config/model-discovery.ts
// function `discoverOpenAIModelsList` and helpers around lines 793-860.

import type { ModelKind, PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';

export interface OmpPublicModel extends PublicModel {
  context_length?: number;
  input_modalities?: string[];
  output_modalities?: string[];
}

export interface OmpPublicModelsResponse {
  object: 'list';
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: OmpPublicModel[];
}

// Prefix check for omp discovery User-Agent (`floway-omp/<version>`).
export const isOmpUserAgent = (userAgent: string | undefined): boolean =>
  userAgent?.startsWith('floway-omp/') ?? false;

// Kinds supported by omp's discovery. omp can only route chat, embedding,
// or image-generation models. Non-supported kinds (e.g. rerank, transcription)
// lack task metadata that omp recognizes and would default to chat models,
// so they are strictly omitted from the omp catalog.
export const isOmpSupportedKind = (kind: ModelKind): boolean =>
  kind === 'chat' || kind === 'embedding' || kind === 'image';

const mapInputModality = (modality: string): string => {
  const lower = modality.toLowerCase();
  if (lower === 'text') return 'text';
  if (lower === 'image') return 'image';
  return lower;
};

// Map a PublicModel into an omp-enriched model.
// Preserves every existing field of PublicModel unchanged (additive only).
//
// Note on limits.max_input_tokens:
// We intentionally omit setting `limits.max_input_tokens`. omp only uses
// `limits.max_input_tokens` as a fallback context window calculation
// (`limits.max_input_tokens + limits.max_output_tokens`) when `context_length`
// is absent. For modern LLMs with a shared token pool (prompt + output <= context),
// summing prompt limit and output limit can yield an inflated or incorrect context
// window. Providing top-level `context_length` directly resolves the context
// window cleanly whenever `limits.max_context_window_tokens` is known; when absent,
// omp safely falls back to its bundled catalog or defaults.
export const toOmpPublicModel = (model: PublicModel): OmpPublicModel => {
  const enriched: OmpPublicModel = {
    ...model,
  };

  if (model.limits.max_context_window_tokens !== undefined) {
    enriched.context_length = model.limits.max_context_window_tokens;
  }

  if (model.chat?.modalities?.input !== undefined) {
    enriched.input_modalities = model.chat.modalities.input.map(mapInputModality);
  }

  if (model.kind === 'embedding') {
    enriched.output_modalities = ['embedding'];
  } else if (model.kind === 'image') {
    enriched.output_modalities = ['image'];
  }

  return enriched;
};

// Enrich the public model catalog for omp discovery and filter out
// non-chat/non-embedding/non-image kinds.
export const toOmpCatalog = (response: PublicModelsResponse): OmpPublicModelsResponse => {
  const data: OmpPublicModel[] = [];
  for (const model of response.data) {
    if (!isOmpSupportedKind(model.kind)) {
      continue;
    }
    data.push(toOmpPublicModel(model));
  }

  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
