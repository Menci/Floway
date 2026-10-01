import type { GatewayFacts } from '../../../../pipeline/facts.ts';
import type { WebSearchCallIR, WebSearchFilters } from '../../../../tools/web-search/operations.ts';
import type { OpenAIResponsesInputItem } from '@floway-dev/protocols/openai-responses';

export interface WebSearchRequest {
  commands: Record<string, unknown>;
  toolName: string;
  iterationCount: number;
  filters: WebSearchFilters;
  includeSearchActionSources: boolean;
  settings: Record<string, unknown>;
  input: OpenAIResponsesInputItem[];
}

export interface WebSearchSubRequestFacts extends GatewayFacts {
  'request.webSearch.canonical': WebSearchRequest;
  'response.webSearch.ir': WebSearchCallIR;
}

export type Fields<K extends keyof WebSearchSubRequestFacts> = { [P in K]: WebSearchSubRequestFacts[P] };
