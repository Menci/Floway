import type { CustomAuthStyle, CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';
import { type FetchInit, type UpstreamFetchOptions, joinBaseAndPath } from '@floway-dev/provider';

// https://docs.anthropic.com/en/api/versioning
const ANTHROPIC_VERSION = '2023-06-01';

// Each endpoint key names a canonical path fragment. Most resolve to
// `/v1<key>`; pathOverrides (see config.ts) replace the whole path one-for-one.
// The messages count-tokens and responses compact endpoints append a suffix to
// their parent's resolved path so an override of the parent ripples down to
// both.
//
// `/v1beta/models` is the one path whose default is not `/v1<key>`: Gemini's
// per-model actions hang off the model-collection root, and `v1beta` is the
// version every current SDK defaults to. It governs generation only; the
// catalog listing keeps its own fetch toggle, because a Gemini-compatible
// upstream commonly answers `/v1/models` in the OpenAI shape.
const DEFAULT_CUSTOM_PATHS: Readonly<Record<CustomPathOverrideKey, string>> = {
  '/completions': '/v1/completions',
  '/chat/completions': '/v1/chat/completions',
  '/responses': '/v1/responses',
  '/messages': '/v1/messages',
  '/v1beta/models': '/v1beta/models',
  '/embeddings': '/v1/embeddings',
  '/alpha/search': '/v1/alpha/search',
  '/images/generations': '/v1/images/generations',
  '/images/edits': '/v1/images/edits',
  '/audio/transcriptions': '/v1/audio/transcriptions',
};

const pathOverrideFor = (config: CustomUpstreamConfig, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? DEFAULT_CUSTOM_PATHS[key];

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
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/chat/completions'), init, options);
export const customFetchOpenAIResponses = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/responses'), init, options);
export const customFetchOpenAIResponsesCompact = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', `${pathOverrideFor(config, '/responses')}/compact`, init, options);
export const customFetchAnthropicMessages = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-api-key', pathOverrideFor(config, '/messages'), init, options);
export const customFetchAnthropicMessagesCountTokens = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-api-key', `${pathOverrideFor(config, '/messages')}/count_tokens`, init, options);
export const customFetchOpenAIEmbeddings = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/embeddings'), init, options);
export const customFetchOpenAICompletions = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/completions'), init, options);
export const customFetchOpenAIImagesGenerations = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/images/generations'), init, options);
export const customFetchOpenAIImagesEdits = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/images/edits'), init, options);
export const customFetchOpenAIAudioTranscriptions = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/audio/transcriptions'), init, options);
export const customFetchAlphaSearch = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'bearer', pathOverrideFor(config, '/alpha/search'), init, options);
// /models lives on its own fetch toggle (see config.modelsFetch), not in
// pathOverrides. It uses the fetch-specific auth style because the endpoint
// itself carries no protocol identity.
// Gemini's native surface puts the model id and the action in the path and
// selects SSE with a query parameter; the body carries neither. `modelId`
// arrives already stripped of any `models/` prefix.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
const geminiGenerateContentPath = (config: CustomUpstreamConfig, modelId: string, action: 'streamGenerateContent' | 'countTokens'): string => {
  const query = action === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${pathOverrideFor(config, '/v1beta/models')}/${encodeURIComponent(modelId)}:${action}${query}`;
};

// The protocol chooses the credential header, exactly as for the other
// inference surfaces: Google authenticates with `x-goog-api-key`, not a bearer
// token.
// https://ai.google.dev/gemini-api/docs/api-key
export const customFetchGeminiGenerateContent = (config: CustomUpstreamConfig, modelId: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-goog-api-key', geminiGenerateContentPath(config, modelId, 'streamGenerateContent'), init, options);

export const customFetchGeminiGenerateContentCountTokens = (config: CustomUpstreamConfig, modelId: string, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(config, 'x-goog-api-key', geminiGenerateContentPath(config, modelId, 'countTokens'), init, options);

export const customFetchModels = (config: CustomUpstreamConfig, init: FetchInit, options: UpstreamFetchOptions): Promise<Response> =>
  customFetchInternal(
    config,
    config.modelsFetch.authStyle,
    config.modelsFetch.endpoint ?? '/v1/models',
    init,
    options,
  );
