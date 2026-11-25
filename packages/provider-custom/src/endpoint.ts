import type { CustomPathOverrideKey, CustomUpstreamConfig } from './config.ts';

// Derived operations append to the resolved parent path, including any override.
// Gemini's model collection is already versioned and carries per-model actions.
// https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
export const customPath = (config: Readonly<Pick<CustomUpstreamConfig, 'pathOverrides'>>, key: CustomPathOverrideKey): string =>
  config.pathOverrides?.[key] ?? (key === '/v1beta/models' ? key : `/v1${key}`);

export const geminiGenerateContentPath = (config: Readonly<Pick<CustomUpstreamConfig, 'pathOverrides'>>, modelId: string, action: 'streamGenerateContent' | 'countTokens'): string => {
  const query = action === 'streamGenerateContent' ? '?alt=sse' : '';
  return `${customPath(config, '/v1beta/models')}/${encodeURIComponent(modelId)}:${action}${query}`;
};
