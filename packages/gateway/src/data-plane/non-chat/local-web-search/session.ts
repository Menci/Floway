import type { SearchAborted, SearchOptions } from './facts.ts';
import type { LocalWebSearchService } from './services.ts';
import type { WebSearchExecutionSession } from '../../tools/web-search/operations.ts';
import { isCausedBy } from '@floway-dev/http';

export const searchSession = (
  service: LocalWebSearchService,
  options: SearchOptions,
  signal: AbortSignal,
): WebSearchExecutionSession => ({
  ...options,
  pageCache: service.pageCache,
  apiKeyId: service.apiKeyId,
  getBackend: () => service.getBackend(),
  signal,
});

export const searchAbort = (cause: unknown, signal: AbortSignal): SearchAborted => {
  if (!isCausedBy(cause, signal.reason)) throw cause;
  return { kind: 'abort', cause };
};
