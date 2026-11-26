import type { CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';

// https://platform.openai.com/docs/api-reference
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

type PathOverrides = Pick<CustomUpstreamConfig, 'pathOverrides'>;

export const customOperationPath = (config: PathOverrides, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? DEFAULT_CUSTOM_PATHS[key];

// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// https://ai.google.dev/api/tokens#method:-models.counttokens
export const customGeminiModelActionPath = (config: PathOverrides, modelId: string, action: 'streamGenerateContent' | 'countTokens'): string => {
  const query = action === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${customOperationPath(config, '/v1beta/models')}/${encodeURIComponent(modelId)}:${action}${query}`;
};
