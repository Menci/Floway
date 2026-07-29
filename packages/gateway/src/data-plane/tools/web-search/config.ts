import type { WebSearchConfig } from './types.ts';
import { getRepo } from '../../../repo/index.ts';
import { isJsonObject } from '../../../shared/json-helpers.ts';
import { WEB_SEARCH_PROVIDER_NAMES, isWebSearchProviderName } from '../../../shared/web-search-providers.ts';

export const DEFAULT_WEB_SEARCH_CONFIG: WebSearchConfig = {
  provider: 'disabled',
  tavily: { apiKey: '' },
  microsoftWebIq: { apiKey: '' },
  jina: { apiKey: '' },
  passthroughOpenAiSearch: { enabled: false, upstreamId: '', model: '' },
};

export const FIXED_WEB_SEARCH_CONFIG_TEST_QUERY = 'React documentation';

// Returns a fresh deep copy so callers can mutate without corrupting
// the module-scoped singleton.
export const parseWebSearchConfigDefault = (): WebSearchConfig => structuredClone(DEFAULT_WEB_SEARCH_CONFIG);

// Strict parse: throws on malformed shape so persistence corruption
// surfaces instead of silently downgrading to `disabled`.
export const parseWebSearchConfigStrict = (input: unknown): WebSearchConfig => {
  if (!isJsonObject(input)) {
    throw new Error('search config must be a JSON object');
  }
  if (input.provider !== 'disabled' && !isWebSearchProviderName(input.provider)) {
    const allowed = ['disabled', ...WEB_SEARCH_PROVIDER_NAMES].map(name => `'${name}'`).join(', ');
    throw new Error(`search config provider must be one of ${allowed}, got ${JSON.stringify(input.provider)}`);
  }
  if (!isJsonObject(input.tavily)) {
    throw new Error('search config tavily must be an object');
  }
  if (typeof input.tavily.apiKey !== 'string') {
    throw new Error('search config tavily.apiKey must be a string');
  }
  if (!isJsonObject(input.microsoftWebIq)) {
    throw new Error('search config microsoftWebIq must be an object');
  }
  if (typeof input.microsoftWebIq.apiKey !== 'string') {
    throw new Error('search config microsoftWebIq.apiKey must be a string');
  }
  if (!isJsonObject(input.jina)) {
    throw new Error('search config jina must be an object');
  }
  if (typeof input.jina.apiKey !== 'string') {
    throw new Error('search config jina.apiKey must be a string');
  }
  if (!isJsonObject(input.passthroughOpenAiSearch)) {
    throw new Error('search config passthroughOpenAiSearch must be an object');
  }
  const passthrough = input.passthroughOpenAiSearch;
  if (typeof passthrough.enabled !== 'boolean' || typeof passthrough.upstreamId !== 'string' || typeof passthrough.model !== 'string') {
    throw new Error('search config passthroughOpenAiSearch must contain enabled, upstreamId, and model');
  }
  const upstreamId = passthrough.upstreamId.trim();
  const model = passthrough.model.trim();
  if (passthrough.enabled && (upstreamId === '' || model === '')) {
    throw new Error('enabled OpenAI search passthrough requires an upstream and model');
  }
  return {
    provider: input.provider,
    tavily: { apiKey: input.tavily.apiKey.trim() },
    microsoftWebIq: { apiKey: input.microsoftWebIq.apiKey.trim() },
    jina: { apiKey: input.jina.apiKey.trim() },
    passthroughOpenAiSearch: { enabled: passthrough.enabled, upstreamId, model },
  };
};

export const loadWebSearchConfig = async (): Promise<WebSearchConfig> => {
  const stored = await getRepo().webSearchConfig.get();
  if (stored === null) return parseWebSearchConfigDefault();
  return parseWebSearchConfigStrict(stored);
};

export const saveWebSearchConfig = async (config: unknown): Promise<WebSearchConfig> => {
  const parsed = parseWebSearchConfigStrict(config);
  await getRepo().webSearchConfig.save(parsed);
  return parsed;
};
