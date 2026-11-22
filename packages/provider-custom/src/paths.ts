import type { CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';

// Each endpoint key names a canonical path fragment. Most resolve to
// `/v1<key>`; pathOverrides replace the whole path one-for-one. Derived
// endpoints append their action to the parent override.
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

export const customPathFor = (config: CustomUpstreamConfig, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? DEFAULT_CUSTOM_PATHS[key];

export const appendPathSegment = (path: string, suffix: string): string => {
  const queryIndex = path.indexOf('?');
  return queryIndex < 0
    ? `${path}${suffix}`
    : `${path.slice(0, queryIndex)}${suffix}${path.slice(queryIndex)}`;
};

// Gemini carries the model and action in the path. Generation selects SSE in
// the query string; neither field belongs in the body.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// https://ai.google.dev/api/tokens#method:-models.counttokens
// https://ai.google.dev/gemini-api/docs/api-key
export const customGeminiActionPath = (
  config: CustomUpstreamConfig,
  modelId: string,
  action: 'streamGenerateContent' | 'countTokens',
): string => {
  const path = appendPathSegment(
    customPathFor(config, '/v1beta/models'),
    `/${encodeURIComponent(modelId)}:${action}`,
  );
  return action === 'streamGenerateContent' ? `${path}${path.includes('?') ? '&' : '?'}alt=sse` : path;
};
