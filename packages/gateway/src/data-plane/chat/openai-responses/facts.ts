import type { StreamOutcome } from '../../pipeline/serve.ts';
import type { ChatFacts } from '../facts.ts';
import type { Deferred } from '@floway-dev/pipeline';
import type { SseFrame, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ClientOpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';

/** How the transport that opened the run frames a streamed answer. Both carry this
 *  protocol's own events and neither adds or drops one: SSE is the format an HTTP body is
 *  written in, terminator and all, and a WebSocket turn writes each event as a text frame of
 *  its own — so the transport that owns the socket takes the events and frames them itself. */
export type OpenAIResponsesStreamFraming = 'sse' | 'events';

/** What this family adds to the chat space. */
export interface OpenAIResponsesFacts extends ChatFacts {
  /** Server-only state the gateway once attached to an item it emitted, keyed by that
   *  item's id, as the rows this turn hydrated carry it. It never reaches an upstream: it is
   *  what lets an item this turn re-emits be stored with the state it already had.
   *
   *  Pairs rather than a `Map`, for the same reason the header keys are: a `Map` has no own
   *  properties, so it would be written into the dump as an empty object and the record would
   *  say the turn hydrated nothing. */
  'request.chat.openaiResponses.privatePayloads': readonly (readonly [string, unknown])[];
  /** What the client is actually sent — an object when it asked for one, and the stream it
   *  asked to be streamed, in the framing its transport writes. The edge provides it, so a
   *  dump shows what the client received. */
  'response.chat.openaiResponses.rendered': Record<string, unknown> | AsyncIterable<SseFrame> | AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.openaiResponses.streamedUsage': Deferred<StreamOutcome> | null;
}

export type Fields<K extends keyof OpenAIResponsesFacts> = { [P in K]: OpenAIResponsesFacts[P] };

/** This family's own reading, which every wire under it hands up. */
export const OPENAI_RESPONSES_STREAMED_USAGE = 'response.chat.openaiResponses.streamedUsage';

export type OpenAIResponsesServeEntry = Fields<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.openaiResponses.wantsStream'
  | 'request.chat.openaiResponses' | 'serve.model'
>;

export type OpenAIResponsesServeExit = Fields<
  'response.chat.openaiResponses.rendered' | 'response.chat.openaiResponses.streamedUsage'
  | 'response.http.status' | 'response.http.jsonBody' | 'response.http.headers' | 'response.usage.billable'
>;
