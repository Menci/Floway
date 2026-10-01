import type { AlphaSearchRequest, AlphaSearchResponse } from './protocol.ts';
import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { WebSearchOperation, WebSearchFilters } from '../tools/web-search/operations.ts';

/** Search's own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface SearchFacts extends GatewayFacts {
  'request.search.alphaSearch': AlphaSearchRequest;
  /** What Codex's commands mean to this gateway. Local execution runs on these and never
   *  reads Codex's request again, which is why the stage that provides them consumes it. */
  'request.search.operations': readonly WebSearchOperation[];
  'request.search.filters': WebSearchFilters;
  'response.search.alphaSearch': AlphaSearchResponse | Failure;
  /** What the client is actually sent, in Codex's protocol. The edge provides it, so a dump
   *  shows the bytes the client received rather than the gateway's own form. */
  'response.search.rendered': Record<string, unknown>;
}

export type Fields<K extends keyof SearchFacts> = { [P in K]: SearchFacts[P] };

/** The operator's pinned search upstream. One upstream and one model, both from
 *  configuration, which is why nothing here narrows a candidate list. */
export interface PinnedSearchUpstream {
  readonly kind: 'upstream';
  readonly upstreamId: string;
  readonly model: string;
}

/** Which ending the chain gets. `upstream` is the operator's `passthroughOpenAiSearch`
 *  setting: the word there is about whose search results the client is given, not about
 *  carrying a protocol the gateway has not parsed. */
export type SearchExecution = { readonly kind: 'local' } | PinnedSearchUpstream;
