import type { DecisionTarget, ModelEndpoints, ModelKind, RerankTarget } from '@floway-dev/protocols/browser';
import type { UpstreamProviderKind } from '@floway-dev/provider/browser';

// The path each endpoint is addressed by, unversioned: the editor labels its
// checkboxes with the public route rather than with the key the config stores.
// Gemini labels the whole action family, since the model id and the action are
// part of one path segment.
export const ENDPOINT_PATHS = {
  openaiCompletions: '/completions',
  openaiChatCompletions: '/chat/completions',
  openaiResponses: '/responses',
  anthropicMessages: '/messages',
  geminiGenerateContent: '/models/{model}:generateContent',
  openaiEmbeddings: '/embeddings',
  rerank: '/alpha/search',
  openaiImagesGenerations: '/images/generations',
  openaiImagesEdits: '/images/edits',
  openaiAudioTranscriptions: '/audio/transcriptions',
  decision: '/decisions',
} as const satisfies Record<keyof ModelEndpoints, string>;

// The pathOverrides key an endpoint's upstream path is edited under. Gemini has
// none: its generation root is fixed under the model-collection path and the
// catalog listing is a separate field, so `baseUrl` places both.
const PATH_OVERRIDE_KEY_FOR_ENDPOINT = {
  openaiCompletions: '/completions',
  openaiChatCompletions: '/chat/completions',
  openaiResponses: '/responses',
  anthropicMessages: '/messages',
  openaiEmbeddings: '/embeddings',
  rerank: '/alpha/search',
  openaiImagesGenerations: '/images/generations',
  openaiImagesEdits: '/images/edits',
  openaiAudioTranscriptions: '/audio/transcriptions',
  decision: '/decisions',
} as const satisfies Record<Exclude<keyof ModelEndpoints, 'geminiGenerateContent'>, string>;

export const CHAT_ENDPOINT_KEYS = ['openaiCompletions', 'openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'geminiGenerateContent'] as const satisfies readonly (keyof ModelEndpoints)[];
export const IMAGE_ENDPOINT_KEYS = ['openaiImagesGenerations', 'openaiImagesEdits'] as const satisfies readonly (keyof ModelEndpoints)[];

// How the editor names an endpoint. The path is the wire detail, shown as the
// label's info; the name is what the protocol is called.
export const ENDPOINT_LABELS = {
  openaiCompletions: 'OpenAI Completions',
  openaiChatCompletions: 'OpenAI Chat Completions',
  openaiResponses: 'OpenAI Responses',
  anthropicMessages: 'Anthropic Messages',
  geminiGenerateContent: 'Gemini GenerateContent',
  openaiEmbeddings: 'OpenAI Embeddings',
  rerank: 'Rerank',
  openaiImagesGenerations: 'OpenAI Images Generations',
  openaiImagesEdits: 'OpenAI Images Edits',
  openaiAudioTranscriptions: 'OpenAI Audio Transcriptions',
  decision: 'Decision',
} as const satisfies Record<keyof ModelEndpoints, string>;

// Every endpoint the custom provider accepts an override for, in the order the
// editor lists them: the field path it is stored under, the protocol name shown
// beside it, and the default that seeds the placeholder. OpenAI Audio
// Transcriptions is deliberately absent from the form yet kept in the value, so
// an override stored for it survives a save. The literal `path` values keep the
// editor's form-field paths checked against the config shape.
export const PATH_OVERRIDE_OPTIONS = ([
  'openaiCompletions',
  'openaiChatCompletions',
  'openaiResponses',
  'anthropicMessages',
  'openaiEmbeddings',
  'rerank',
  'openaiImagesGenerations',
  'openaiImagesEdits',
] as const satisfies readonly Exclude<keyof ModelEndpoints, 'geminiGenerateContent'>[])
  .map(key => ({ key, label: ENDPOINT_LABELS[key], path: PATH_OVERRIDE_KEY_FOR_ENDPOINT[key] }));

export interface EndpointOption {
  readonly key: keyof ModelEndpoints;
  readonly label: string;
  readonly path: string;
}

export const endpointOptionsFor = (
  keys: readonly (keyof ModelEndpoints)[],
): EndpointOption[] => keys.map(key => ({ key, label: ENDPOINT_LABELS[key], path: ENDPOINT_PATHS[key] }));

// The rerank dialect a row starts on. `/alpha/search` speaks six mutually
// incompatible dialects and no upstream catalog names the one it implements,
// so a rerank row the gateway will accept has to start on some target and the
// operator confirms or changes it.
const INITIAL_RERANK_TARGET: RerankTarget = { protocol: 'cohere-v2' };

// A new decision row starts on the System One contract, which most providers
// serve; the operator changes the dialect when the target speaks OpenAI
// Decisions. An upstream that knows its own dialect fills the same default in.
const INITIAL_DECISION_TARGET: DecisionTarget = { protocol: 'typesafe-systemone' };

// What a discovered model declares when it names no kind of its own, or names
// `chat`. The gateway hands both the upstream's configured map unchanged
// (autoModelEndpoints, packages/provider-custom/src/provider.ts) and the auto
// row says what the gateway will serve, so the row mirrors it rather than
// taking the chat family the kind picker offers -- that filter would drop a
// configured OpenAI Embeddings or rerank path and then persist the loss through the
// auto-to-manual conversion.
export const configuredEndpoints = (configured: ModelEndpoints): ModelEndpoints =>
  Object.keys(configured).length ? structuredClone(configured) : { openaiChatCompletions: {} };

// Everything a model's kind decides about its own shape, for every place that
// puts a model into a kind: the discovered-model projection of a model that
// declares a kind of its own, the kind picker, and the auto-to-manual
// conversion. Chat and image models may be served by more than one endpoint, so
// a selection already made inside the family is kept and only an empty one
// falls back to the family default.
// `providerKind` decides which per-model targets the operator may author: only a
// custom upstream leaves the wire dialect open, so Azure, Ollama, and Copilot
// rows never carry one.
export const shapeForKind = (
  kind: ModelKind,
  current: { endpoints: ModelEndpoints; rerankTarget?: RerankTarget; decisionTarget?: DecisionTarget },
  providerKind: UpstreamProviderKind,
): { endpoints: ModelEndpoints; rerankTarget?: RerankTarget; decisionTarget?: DecisionTarget } => {
  if (kind === 'embedding') return { endpoints: { openaiEmbeddings: {} } };
  if (kind === 'transcription') return { endpoints: { openaiAudioTranscriptions: {} } };
  if (kind === 'rerank') return { endpoints: { rerank: {} }, rerankTarget: current.rerankTarget ?? INITIAL_RERANK_TARGET };
  if (kind === 'decision') return providerKind === 'custom'
    ? { endpoints: { decision: {} }, decisionTarget: current.decisionTarget ?? INITIAL_DECISION_TARGET }
    : { endpoints: { decision: {} } };
  const family = kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS;
  const kept: ModelEndpoints = {};
  for (const key of family) if (current.endpoints[key]) kept[key] = current.endpoints[key];
  if (Object.keys(kept).length) return { endpoints: kept };
  return { endpoints: kind === 'image' ? { openaiImagesGenerations: {}, openaiImagesEdits: {} } : { openaiChatCompletions: {} } };
};
