// HTTP transport for the ollama upstream. Joins the operator's base URL to
// each Ollama endpoint path, sets `Authorization: Bearer <apiKey>` when an
// API key is configured (omitting the header on an unauthenticated daemon),
// and adds `Content-Type: application/json` for JSON request bodies.
//
// Endpoint paths are fixed: ollama.com and a self-hosted daemon serve the
// same routes from the same Go binary, so there is no pathOverrides escape
// hatch the way the generic custom provider needs.

import type { OllamaUpstreamConfig } from './config.ts';
import { type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const OLLAMA_PATHS = {
  completions: '/v1/completions',
  chat_completions: '/v1/chat/completions',
  responses: '/v1/responses',
  messages: '/v1/messages',
  embeddings: '/v1/embeddings',
  tags: '/api/tags',
  show: '/api/show',
} as const;

const ollamaFetchInternal = async (
  config: OllamaUpstreamConfig,
  path: string,
  init: RequestInit,
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
  return await options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }, options.recordUpstreamLatency);
};

export const ollamaFetchChatCompletions = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.chat_completions, init, options);
export const ollamaFetchResponses = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.responses, init, options);
export const ollamaFetchResponsesCompact = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, `${OLLAMA_PATHS.responses}/compact`, init, options);
export const ollamaFetchMessages = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.messages, init, options);
export const ollamaFetchMessagesCountTokens = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, `${OLLAMA_PATHS.messages}/count_tokens`, init, options);
export const ollamaFetchEmbeddings = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.embeddings, init, options);
export const ollamaFetchCompletions = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.completions, init, options);
export const ollamaFetchTags = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.tags, init, options);
export const ollamaFetchShow = (config: OllamaUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  ollamaFetchInternal(config, OLLAMA_PATHS.show, init, options);
