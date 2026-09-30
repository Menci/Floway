import type { WebSearchRequest } from './facts.ts';
import type { GatewayServices } from '../../../../pipeline/services.ts';
import type { WebSearchCallIR, WebSearchExecutionSession } from '../../../../tools/web-search/operations.ts';
import type { OpenAIResponsesWebSearchAction } from '@floway-dev/protocols/openai-responses';

export interface WebSearchRuntime {
  readonly session: Omit<WebSearchExecutionSession, 'filters' | 'includeSearchActionSources'>;
  readonly executeAlpha?: (request: WebSearchRequest, action: OpenAIResponsesWebSearchAction) => Promise<WebSearchCallIR>;
}

export interface SearchServices extends GatewayServices { readonly webSearch: WebSearchRuntime }
