import type { GatewayFacts } from '../../../../pipeline/facts.ts';
import type { WebSearchCallIR } from '../../../../tools/web-search/operations.ts';

/** What one search call is, and what it came to. */
export interface WebSearchSubRequestFacts extends GatewayFacts {
  'request.webSearch.action': 'search';
  /** What the backend answered, in the shape the hosted-tool item is built from. */
  'response.webSearch.ir': WebSearchCallIR;
}

export type Fields<K extends keyof WebSearchSubRequestFacts> = { [P in K]: WebSearchSubRequestFacts[P] };
