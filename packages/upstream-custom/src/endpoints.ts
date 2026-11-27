import type { CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';
import { joinBaseAndPath } from '@floway-dev/upstream';

// https://developers.openai.com/api/reference
// https://platform.claude.com/docs/en/api/messages
// https://ai.google.dev/api/generate-content
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
  '/audio/speech': '/v1/audio/speech',
  '/audio/transcriptions': '/v1/audio/transcriptions',
};

export const pathOverrideFor = (config: CustomUpstreamConfig, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? DEFAULT_CUSTOM_PATHS[key];

export const customActionUrl = (config: CustomUpstreamConfig, path: string, action: string): URL => {
  const url = new URL(joinBaseAndPath(config.baseUrl, path));
  url.pathname += action;
  return url;
};

// A catalog can prefix native model IDs with models/; the action path takes the bare ID.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
export const bareGeminiModelId = (id: string): string => id.replace(/^models\//, '');

// The model and action are path components. Gemini's streaming action
// selects SSE with alt=sse.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// https://ai.google.dev/api/tokens#method:-models.counttokens
export const geminiGenerateContentUrl = (config: CustomUpstreamConfig, modelId: string, action: 'streamGenerateContent' | 'countTokens'): URL => {
  const url = customActionUrl(config, pathOverrideFor(config, '/v1beta/models'), `/${encodeURIComponent(modelId)}:${action}`);
  if (action === 'streamGenerateContent') url.searchParams.set('alt', 'sse');
  return url;
};
