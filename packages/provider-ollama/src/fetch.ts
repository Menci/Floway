// HTTP transport for the Ollama upstream (ollama.com or a self-hosted daemon;
// API key optional for the latter).
//
// Endpoint paths are fixed: ollama.com and a self-hosted daemon serve the
// same routes from the same Go binary, so there is no pathOverrides escape
// hatch the way the generic custom provider needs.

import type { OllamaUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const ollamaFetchInternal = async (
  config: OllamaUpstreamConfig,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

export const ollamaFetchChatCompletions = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/chat/completions', init, options);
export const ollamaFetchResponses = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/responses', init, options);
export const ollamaFetchResponsesCompact = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/responses/compact', init, options);
export const ollamaFetchMessages = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/messages', init, options);
export const ollamaFetchMessagesCountTokens = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/messages/count_tokens', init, options);
export const ollamaFetchEmbeddings = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/embeddings', init, options);
export const ollamaFetchCompletions = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/completions', init, options);
// Stock Ollama mounts this OpenAI-compatible route, parses its multipart body,
// and adapts the audio into an internal chat request. Capability discovery does
// not advertise a dedicated transcription bit, so the provider exposes it only
// through manual `audioTranscriptions` model entries.
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1916-L1922
// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
export const ollamaFetchAudioTranscriptions = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/v1/audio/transcriptions', init, options);
export const ollamaFetchTags = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/api/tags', init, options);
export const ollamaFetchShow = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/api/show', init, options);
// Account-level usage windows. Cloud-only — see usage-probe.ts for the
// endpoint's provenance and the shape it returns.
export const ollamaFetchUsage = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/api/usage', init, options);
// The account behind the API key, including its plan. Cloud-only — see
// account-probe.ts for the endpoint's provenance. POST, not GET: the route is
// registered for POST only and answers 405 otherwise.
// https://github.com/ollama/ollama/blob/f0078ae4766d0d570e196158f20dde309bd96124/api/client.go#L506
export const ollamaFetchMe = (config: OllamaUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, '/api/me', init, options);
