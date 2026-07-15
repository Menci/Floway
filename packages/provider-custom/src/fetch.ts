import type { CustomUpstreamConfig } from './config.ts';
import { type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

const ANTHROPIC_VERSION = '2023-06-01';

// Endpoint key is the OpenAI-canonical path fragment (`/chat/completions`,
// `/images/generations`, ...). The default upstream URL is the key prefixed
// with `/v1`; pathOverrides (see config.ts) replace it one-for-one. The
// messages count-tokens and responses compact endpoints append a suffix
// to their parent's resolved path so an override of the parent ripples
// down to both.
type EndpointKey = keyof NonNullable<CustomUpstreamConfig['pathOverrides']>;

const resolveOverridable = (config: CustomUpstreamConfig, key: EndpointKey): string =>
  config.pathOverrides?.[key] ?? `/v1${key}`;

const customFetchInternal = async (
  config: CustomUpstreamConfig,
  path: string,
  init: RequestInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers = new Headers(init.headers);
  if (config.authStyle === 'anthropic') {
    headers.set('x-api-key', config.apiKey);
    if (!headers.has('anthropic-version')) headers.set('anthropic-version', ANTHROPIC_VERSION);
  } else if (config.authStyle === 'bearer') {
    headers.set('Authorization', `Bearer ${config.apiKey}`);
  }
  // authStyle === 'none' falls through with no auth header. The same goes
  // for the /models fetch — Models Fetch shares this code path, so a 'none'
  // upstream is queried anonymously end-to-end.
  if (init.body && !headers.has('Content-Type') && !(init.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (options.extraHeaders) {
    for (const [k, v] of options.extraHeaders) headers.set(k, v);
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

export const customFetchChatCompletions = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/chat/completions'), init, options);
export const customFetchResponses = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/responses'), init, options);
export const customFetchResponsesCompact = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, `${resolveOverridable(config, '/responses')}/compact`, init, options);
export const customFetchMessages = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/messages'), init, options);
export const customFetchMessagesCountTokens = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, `${resolveOverridable(config, '/messages')}/count_tokens`, init, options);
export const customFetchEmbeddings = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/embeddings'), init, options);
export const customFetchCompletions = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/completions'), init, options);
export const customFetchImagesGenerations = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/images/generations'), init, options);
export const customFetchImagesEdits = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/images/edits'), init, options);
export const customFetchAlphaSearch = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, resolveOverridable(config, '/alpha/search'), init, options);
// /models lives on its own fetch toggle (see config.modelsFetch.endpoint),
// not in pathOverrides.
export const customFetchModels = (config: CustomUpstreamConfig, init: RequestInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, config.modelsFetch.endpoint ?? '/v1/models', init, options);
