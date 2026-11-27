import type { WebSearchConfig, WebSearchBackendName } from '../../../shared/web-search-backends.ts';
import type { AnthropicMessagesWebSearchErrorCode } from '@floway-dev/protocols/anthropic-messages';

export type { WebSearchConfig, WebSearchBackendName } from '../../../shared/web-search-backends.ts';

export const DEFAULT_WEB_SEARCH_RESULT_COUNT = 10;

// Hard cap (UTF-8 bytes) on a single page returned by `fetchPage`. The shim's
// downstream function_call_output strings carry this content, so the cap keeps
// model-visible tool output bounded regardless of upstream page size. Same cap
// for every provider so the shim's truncation handling is provider-agnostic.
export const MAX_FETCH_PAGE_BYTES = 10_240;

export type WebSearchBackendErrorCode = Exclude<AnthropicMessagesWebSearchErrorCode, 'max_uses_exceeded'>;

export interface WebSearchBackendRequest {
  query: string;
  allowedDomains?: string[] | undefined;
  blockedDomains?: string[] | undefined;
  userLocation?: {
    city?: string | undefined;
    region?: string | undefined;
    country?: string | undefined;
    timezone?: string | undefined;
  } | undefined;
  // When undefined, the provider applies its own default count. The OpenAI Responses
  // shim populates this from the client tool's `search_context_size` field.
  maxResults?: number | undefined;
  // OpenAI Codex `SearchQuery.recency`: only results published or updated
  // within this many days are relevant. Providers without a native date
  // filter treat this as a ranking hint.
  recencyDays?: number | undefined;
  // Aborted when the downstream client disconnects. Providers MUST
  // pass this through to the underlying HTTP fetch so a cancelled
  // request stops generating upstream load instead of running to
  // completion.
  signal?: AbortSignal | undefined;
}

export type WebSearchBackendResult =
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
    errorCode: WebSearchBackendErrorCode;
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
  // See WebSearchBackendRequest.signal — same semantics: providers
  // must thread this into their underlying fetch / sleep so a
  // disconnected client cancels in-flight upstream work.
  signal?: AbortSignal | undefined;
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
      errorCode: WebSearchBackendErrorCode;
      message?: string;
    }>;
  }
  | {
    type: 'error';
    errorCode: WebSearchBackendErrorCode;
    message?: string;
  };

export interface WebSearchBackend {
  search(request: WebSearchBackendRequest): Promise<WebSearchBackendResult>;
  fetchPage(request: WebSearchFetchPageRequest): Promise<WebSearchFetchPageResult>;
}

export type ConfiguredWebSearchBackend =
  | { type: 'disabled' }
  | { type: 'missing-credential'; backend: WebSearchBackendName }
  | {
    type: 'enabled';
    backend: WebSearchBackendName;
    impl: WebSearchBackend;
  };

export type WebSearchConfigConnectionTestResult =
  | {
    ok: true;
    backend: WebSearchConfig['backend'];
    query: string;
    results: WebSearchPreviewResult[];
  }
  | {
    ok: false;
    backend: WebSearchConfig['backend'];
    query: string;
    error: { code: string; message: string };
  };
