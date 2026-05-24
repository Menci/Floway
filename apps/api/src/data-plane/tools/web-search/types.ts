import type { WebSearchProviderName } from '../../../shared/web-search-providers.ts';
import type { MessagesWebSearchErrorCode } from '@floway-dev/protocols/messages';

export type { WebSearchProviderName } from '../../../shared/web-search-providers.ts';

export interface SearchConfig {
  provider: 'disabled' | WebSearchProviderName;
  tavily: { apiKey: string };
  microsoftGrounding: { apiKey: string };
}

export const DEFAULT_WEB_SEARCH_RESULT_COUNT = 10;

export type WebSearchProviderErrorCode = Exclude<MessagesWebSearchErrorCode, 'max_uses_exceeded'>;

export interface WebSearchProviderRequest {
  query: string;
  allowedDomains?: string[];
  blockedDomains?: string[];
  userLocation?: {
    city?: string;
    region?: string;
    country?: string;
    timezone?: string;
  };
}

export type WebSearchProviderResult =
  | {
    type: 'ok';
    results: Array<{
      source: string;
      title: string;
      pageAge?: string;
      content: Array<{ type: 'text'; text: string }>;
    }>;
  }
  | {
    type: 'error';
    errorCode: WebSearchProviderErrorCode;
    message?: string;
  };

export interface WebSearchPreviewResult {
  title: string;
  url: string;
  pageAge?: string;
  previewText: string;
}

export type WebSearchProvider = (request: WebSearchProviderRequest) => Promise<WebSearchProviderResult>;

export type ConfiguredWebSearchProvider =
  | { type: 'disabled' }
  | { type: 'missing-credential'; provider: WebSearchProviderName }
  | {
    type: 'enabled';
    provider: WebSearchProviderName;
    search: WebSearchProvider;
  };

export type SearchConfigConnectionTestResult =
  | {
    ok: true;
    provider: SearchConfig['provider'];
    query: string;
    results: WebSearchPreviewResult[];
  }
  | {
    ok: false;
    provider: SearchConfig['provider'];
    query: string;
    error: { code: string; message: string };
  };
