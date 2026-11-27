import type { DecisionTarget, ModelEndpoints, ModelKind, RerankTarget } from '@floway-dev/protocols/browser';
import type { UpstreamKind } from '@floway-dev/upstream/browser';

// Every override the custom provider accepts, in the order the editor lists it:
// the key the config stores it under, the protocol name shown beside it, and
// the path it resolves to when unset. This is not a projection of the endpoint
// keys: `rerank` and `decision` pick their path per model, and OpenAI Search is
// the one overridable surface with no `ModelEndpoints` key of its own.
export const PATH_OVERRIDE_OPTIONS = [
  { path: '/completions', label: 'OpenAI Completions', defaultPath: '/v1/completions' },
  { path: '/chat/completions', label: 'OpenAI Chat Completions', defaultPath: '/v1/chat/completions' },
  { path: '/responses', label: 'OpenAI Responses', defaultPath: '/v1/responses' },
  { path: '/messages', label: 'Anthropic Messages', defaultPath: '/v1/messages' },
  { path: '/v1beta/models', label: 'Gemini Models', defaultPath: '/v1beta/models' },
  { path: '/embeddings', label: 'OpenAI Embeddings', defaultPath: '/v1/embeddings' },
  { path: '/alpha/search', label: 'OpenAI Search', defaultPath: '/v1/alpha/search' },
  { path: '/images/generations', label: 'OpenAI Images Generations', defaultPath: '/v1/images/generations' },
  { path: '/images/edits', label: 'OpenAI Images Edits', defaultPath: '/v1/images/edits' },
  { path: '/audio/speech', labelKey: 'apiDocs.endpointNames.openAiSpeech', defaultPath: '/v1/audio/speech' },
] as const;

export const CHAT_ENDPOINT_KEYS = ['openaiCompletions', 'openaiChatCompletions', 'openaiResponses', 'anthropicMessages', 'geminiGenerateContent'] as const satisfies readonly (keyof ModelEndpoints)[];
export const IMAGE_ENDPOINT_KEYS = ['openaiImagesGenerations', 'openaiImagesEdits'] as const satisfies readonly (keyof ModelEndpoints)[];

// The endpoints the editor lets an operator pick. Rerank and decision rows
// carry their wire on the target, and embeddings, transcription, and speech
// have one endpoint each.
type SelectableEndpointKey = (typeof CHAT_ENDPOINT_KEYS)[number] | (typeof IMAGE_ENDPOINT_KEYS)[number];

// How the editor names an endpoint.
const ENDPOINT_LABELS = {
  openaiCompletions: 'OpenAI Completions',
  openaiChatCompletions: 'OpenAI Chat Completions',
  openaiResponses: 'OpenAI Responses',
  anthropicMessages: 'Anthropic Messages',
  geminiGenerateContent: 'Gemini GenerateContent',
  openaiImagesGenerations: 'OpenAI Images Generations',
  openaiImagesEdits: 'OpenAI Images Edits',
} as const satisfies Record<SelectableEndpointKey, string>;

export interface EndpointOption {
  readonly key: SelectableEndpointKey;
  readonly label: string;
}

export const endpointOptionsFor = (
  keys: readonly SelectableEndpointKey[],
): EndpointOption[] => keys.map(key => ({ key, label: ENDPOINT_LABELS[key] }));

// The rerank dialect a row starts on. Six mutually incompatible dialects share
// the `rerank` endpoint and no upstream catalog names the one it implements, so
// a rerank row the gateway will accept has to start on some target and the
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
  upstreamKind: UpstreamKind,
): { endpoints: ModelEndpoints; rerankTarget?: RerankTarget; decisionTarget?: DecisionTarget } => {
  switch (kind) {
  case 'embedding': return { endpoints: { openaiEmbeddings: {} } };
  case 'transcription': return { endpoints: { openaiAudioTranscriptions: {} } };
  case 'speech': return { endpoints: { openaiAudioSpeech: {} } };
  case 'rerank': return { endpoints: { rerank: {} }, rerankTarget: current.rerankTarget ?? INITIAL_RERANK_TARGET };
  case 'decision': return upstreamKind === 'custom'
    ? { endpoints: { decision: {} }, decisionTarget: current.decisionTarget ?? INITIAL_DECISION_TARGET }
    : { endpoints: { decision: {} } };
  case 'chat':
  case 'image': {
    const family = kind === 'image' ? IMAGE_ENDPOINT_KEYS : CHAT_ENDPOINT_KEYS;
    const kept: ModelEndpoints = {};
    for (const key of family) if (current.endpoints[key]) kept[key] = current.endpoints[key];
    if (Object.keys(kept).length) return { endpoints: kept };
    return { endpoints: kind === 'image' ? { openaiImagesGenerations: {}, openaiImagesEdits: {} } : { openaiChatCompletions: {} } };
  }
  }
};
