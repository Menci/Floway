export const WEB_SEARCH_PROVIDER_NAMES = ['tavily', 'microsoft-grounding', 'jina'] as const;

export type WebSearchProviderName = (typeof WEB_SEARCH_PROVIDER_NAMES)[number];

export interface SearchConfig {
  provider: 'disabled' | WebSearchProviderName;
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
  jina: { apiKey: string };
  passthroughOpenAiSearch: {
    enabled: boolean;
    upstreamId: string;
    model: string;
  };
}

const WEB_SEARCH_PROVIDER_NAME_SET = new Set<string>(WEB_SEARCH_PROVIDER_NAMES);

export const isWebSearchProviderName = (value: unknown): value is WebSearchProviderName => typeof value === 'string' && WEB_SEARCH_PROVIDER_NAME_SET.has(value);

export const assertWebSearchProviderName = (value: unknown): WebSearchProviderName => {
  if (isWebSearchProviderName(value)) return value;
  throw new TypeError(`Invalid web search provider: ${String(value)}`);
};
