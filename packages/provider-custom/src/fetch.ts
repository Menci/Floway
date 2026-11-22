import type { CustomAuthStyle, CustomUpstreamConfig } from './config.ts';
import { customGeminiActionPath, customPathFor } from './paths.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

// https://docs.anthropic.com/en/api/versioning
const ANTHROPIC_VERSION = '2023-06-01';

// The header block is carried as field lines rather than a `Headers`, because
// a rule set may send one name several times and `Headers.append` merges a
// repeated name into one value on undici.
// https://github.com/nodejs/undici/blob/v8.3.0/lib/web/fetch/headers.js#L236-L258
const has = (lines: readonly (readonly [string, string])[], name: string): boolean =>
  lines.some(([candidate]) => candidate.toLowerCase() === name);

const replace = (lines: [string, string][], name: string, value: string): void => {
  const kept = lines.filter(([candidate]) => candidate.toLowerCase() !== name.toLowerCase());
  lines.length = 0;
  lines.push(...kept, [name, value]);
};

const customFetchInternal = async (
  config: CustomUpstreamConfig,
  authStyle: CustomAuthStyle,
  path: string,
  init: FetchInit,
  options: UpstreamFetchOptions,
): Promise<Response> => {
  const headers: [string, string][] = init.headers ? [...new Headers(init.headers)] : [];
  if (config.apiKey !== '' && authStyle === 'x-api-key') {
    replace(headers, 'x-api-key', config.apiKey);
    if (!has(headers, 'anthropic-version')) headers.push(['anthropic-version', ANTHROPIC_VERSION]);
  } else if (config.apiKey !== '' && authStyle === 'bearer') {
    replace(headers, 'Authorization', `Bearer ${config.apiKey}`);
  } else if (config.apiKey !== '' && authStyle === 'x-goog-api-key') {
    replace(headers, 'x-goog-api-key', config.apiKey);
  }
  if (init.body && !has(headers, 'content-type') && !(init.body instanceof FormData)) {
    headers.push(['Content-Type', 'application/json']);
  }
  if (options.extraHeaders) {
    // Every line the caller supplies for a name replaces this helper's own,
    // and the caller's lines keep their order and their repetitions.
    const supplied = new Set(options.extraHeaders.map(([name]) => name.toLowerCase()));
    const kept = headers.filter(([name]) => !supplied.has(name.toLowerCase()));
    headers.length = 0;
    headers.push(...kept, ...options.extraHeaders.map(([name, value]): [string, string] => [name, value]));
  }
  return await options.wrapUpstreamCall(() => options.fetcher(joinBaseAndPath(config.baseUrl, path), { ...init, headers }));
};

export const customFetchRerank = (config: CustomUpstreamConfig, path: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', path, init, options);

export const customFetchDecision = (config: CustomUpstreamConfig, path: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', path, init, options);

export const customFetchOpenAIChatCompletions = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/chat/completions'), init, options);
export const customFetchOpenAIResponses = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/responses'), init, options);
export const customFetchOpenAIResponsesCompact = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', `${customPathFor(config, '/responses')}/compact`, init, options);
export const customFetchAnthropicMessages = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-api-key', customPathFor(config, '/messages'), init, options);
export const customFetchAnthropicMessagesCountTokens = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-api-key', `${customPathFor(config, '/messages')}/count_tokens`, init, options);
export const customFetchOpenAIEmbeddings = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/embeddings'), init, options);
export const customFetchOpenAICompletions = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/completions'), init, options);
export const customFetchOpenAIImagesGenerations = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/images/generations'), init, options);
export const customFetchOpenAIImagesEdits = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/images/edits'), init, options);
export const customFetchOpenAIAudioTranscriptions = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/audio/transcriptions'), init, options);
export const customFetchAlphaSearch = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', customPathFor(config, '/alpha/search'), init, options);
// Gemini's native surface puts the model id and the action in the path and
// selects SSE with a query parameter; the body carries neither. `modelId`
// arrives already stripped of any `models/` prefix.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// The protocol chooses the credential header, exactly as for the other
// inference surfaces: Google authenticates with `x-goog-api-key`, not a bearer
// token.
// https://ai.google.dev/gemini-api/docs/api-key
export const customFetchGeminiGenerateContent = (config: CustomUpstreamConfig, modelId: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-goog-api-key', customGeminiActionPath(config, modelId, 'streamGenerateContent'), init, options);

export const customFetchGeminiGenerateContentCountTokens = (config: CustomUpstreamConfig, modelId: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-goog-api-key', customGeminiActionPath(config, modelId, 'countTokens'), init, options);

// /models lives on its own fetch toggle (see config.modelsFetch), not in
// pathOverrides. It uses the fetch-specific auth style because the endpoint
// itself carries no protocol identity.
// `pageToken` continues a paginated catalog; only Gemini's listing pages.
export const customFetchModels = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions, pageToken?: string): Promise<Response> => {
  const path = config.modelsFetch.endpoint ?? '/v1/models';
  return customFetchInternal(
    config,
    config.modelsFetch.authStyle,
    pageToken === undefined ? path : `${path}${path.includes('?') ? '&' : '?'}pageToken=${encodeURIComponent(pageToken)}`,
    init,
    options,
  );
};
