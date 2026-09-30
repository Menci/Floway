import type { Failure } from '../../../pipeline/facts.ts';
import type { Fields } from '../facts.ts';

/** What a compaction wire hands up. A compaction is a stream by the time it leaves either
 *  ending — the envelope is expanded into the events the stateful half reads — so the value
 *  arm this protocol's response key also admits is not one this chain ever produces. */
export type Compacted<K extends 'response.chat.openaiResponses'> = {
  [P in K]: { readonly kind: 'stream'; readonly frames: AsyncIterable<unknown> } | Failure;
};

export type OpenAIResponsesCompactEntry = Fields<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.openaiResponses' | 'serve.model'
>;

export type OpenAIResponsesCompactExit = Fields<
  'response.chat.openaiResponses.rendered' | 'response.chat.openaiResponses.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;
