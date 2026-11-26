export const WEB_SEARCH_BACKEND_NAMES = ['tavily', 'microsoft-web-iq', 'jina'] as const;

export type WebSearchBackendName = (typeof WEB_SEARCH_BACKEND_NAMES)[number];

export interface WebSearchConfig {
  backend: 'disabled' | WebSearchBackendName;
  tavily: { apiKey: string };
  microsoftWebIq: { apiKey: string };
  jina: { apiKey: string };
  passthroughOpenAiSearch: {
    enabled: boolean;
    upstreamId: string;
    model: string;
  };
}

const WEB_SEARCH_BACKEND_NAME_SET = new Set<string>(WEB_SEARCH_BACKEND_NAMES);

export const isWebSearchBackendName = (value: unknown): value is WebSearchBackendName => typeof value === 'string' && WEB_SEARCH_BACKEND_NAME_SET.has(value);

export const assertWebSearchBackendName = (value: unknown): WebSearchBackendName => {
  if (isWebSearchBackendName(value)) return value;
  throw new TypeError(`Invalid web search backend: ${String(value)}`);
};
