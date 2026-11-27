// HTTP transport for the Ollama upstream (ollama.com or a self-hosted daemon;
// API key optional for the latter).
//
// Endpoint paths are fixed: ollama.com and a self-hosted daemon serve the
// same routes from the same Go binary, so there is no pathOverrides escape
// hatch the way the generic custom provider needs.

import type { OllamaUpstreamConfig } from './config.ts';
import { type FetchInit, type Fetcher, joinBaseAndPath } from '@floway-dev/upstream';

// https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/server/routes.go#L1906-L1922
export const OLLAMA_INFERENCE_PATHS = {
  openaiChatCompletions: '/v1/chat/completions',
  openaiResponses: '/v1/responses',
  // https://platform.openai.com/docs/api-reference/responses/compact
  openaiResponsesCompact: '/v1/responses/compact',
  anthropicMessages: '/v1/messages',
  // https://platform.claude.com/docs/en/api/messages/count_tokens
  anthropicMessagesCountTokens: '/v1/messages/count_tokens',
  openaiEmbeddings: '/v1/embeddings',
  openaiCompletions: '/v1/completions',
  // The shim adapts multipart audio into chat. Only manual models advertise it.
  // https://github.com/ollama/ollama/blob/573386c35eac76124ffce571f4b0fefa0a7fe13c/middleware/openai.go#L682-L789
  openaiAudioTranscriptions: '/v1/audio/transcriptions',
} as const;

const ollamaFetchInternal = async (
  config: OllamaUpstreamConfig,
  path: string,
  init: FetchInit,
  fetcher: Fetcher,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.apiKey) headers.set('Authorization', `Bearer ${config.apiKey}`);
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  return await fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers });
};

export const ollamaFetchTags = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/tags', init, fetcher);
export const ollamaFetchShow = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/show', init, fetcher);
// Account-level usage windows. Cloud-only — see usage-probe.ts for the
// endpoint's provenance and the shape it returns.
export const ollamaFetchUsage = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/usage', init, fetcher);
// Current account balance; rate-limited independently of inference.
// https://github.com/ollama/ollama/blob/eab97e9f92b9a25c2d52d2cc6c1b1c99bd9fae21/docs/api/balance.mdx
export const ollamaFetchBalance = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/balance', init, fetcher);
// The account behind the API key: identity and the plan it is on. POST-only —
// the endpoint answers 405 to GET. See account-probe.ts for the body's shape.
export const ollamaFetchMe = (config: OllamaUpstreamConfig, init: FetchInit, fetcher: Fetcher): Promise<Response> =>
  ollamaFetchInternal(config, '/api/me', init, fetcher);
