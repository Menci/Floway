import type { GatewayServices } from '../../../../pipeline/services.ts';
import type { WebSearchExecutionSession } from '../../../../tools/web-search/operations.ts';
import type { ModelCandidate } from '@floway-dev/provider';

export interface WebSearchRuntime {
  readonly session: Omit<WebSearchExecutionSession, 'filters' | 'includeSearchActionSources'>;
  readonly alpha?: { readonly candidate: Promise<ModelCandidate>; readonly sessionId: string };
}

export interface SearchServices extends GatewayServices { readonly webSearch: WebSearchRuntime }
