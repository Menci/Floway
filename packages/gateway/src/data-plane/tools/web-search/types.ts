import type { SearchConfig, WebSearchProviderName } from '../../../shared/web-search-providers.ts';
import type { MessagesWebSearchErrorCode } from '@floway-dev/protocols/messages';

export type { SearchConfig, WebSearchProviderName } from '../../../shared/web-search-providers.ts';

export const DEFAULT_WEB_SEARCH_RESULT_COUNT = 10;

// Hard cap (UTF-8 bytes) on a single page returned by `fetchPage`. The shim's
// downstream function_call_output strings carry this content, so the cap keeps
// model-visible tool output bounded regardless of upstream page size. Same cap
// for every provider so the shim's truncation handling is provider-agnostic.
export const MAX_FETCH_PAGE_BYTES = 10_240;

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
  // When undefined, the provider applies its own default count. The Responses
  // shim populates this from the client tool's `search_context_size` field.
  maxResults?: number;
  // Aborted when the downstream client disconnects. Providers MUST
  // pass this through to the underlying HTTP fetch so a cancelled
  // request stops generating upstream load instead of running to
  // completion.
  signal?: AbortSignal;
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

export interface WebSearchFetchPageRequest {
  urls: string[];
  // See WebSearchProviderRequest.signal — same semantics: providers
  // must thread this into their underlying fetch / sleep so a
  // disconnected client cancels in-flight upstream work.
  signal?: AbortSignal;
}

export type WebSearchFetchPageResult =
  | {
    type: 'ok';
    pages: Array<{
      url: string;
      title?: string;
      content: string;
      truncated: boolean;
      fullContentBytes: number;
    }>;
    failures: Array<{
      url: string;
      errorCode: WebSearchProviderErrorCode;
      message?: string;
    }>;
  }
  | {
    type: 'error';
    errorCode: WebSearchProviderErrorCode;
    message?: string;
  };

export interface WebSearchProvider {
  search(request: WebSearchProviderRequest): Promise<WebSearchProviderResult>;
  fetchPage(request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult>;
}

export type ConfiguredWebSearchProvider =
  | { type: 'disabled' }
  | { type: 'missing-credential'; provider: WebSearchProviderName }
  | {
    type: 'enabled';
    provider: WebSearchProviderName;
    impl: WebSearchProvider;
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
