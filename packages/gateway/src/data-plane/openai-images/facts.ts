import type { GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import type { Deferred } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import type { OpenAIImagesStreamEvent, CanonicalOpenAIImagesRequest, CanonicalOpenAIImagesResponse } from '@floway-dev/protocols/openai-images';

/** The answer while it is still the upstream's, one event at a time. There is no transport
 *  sentinel below the events — this protocol ends at its completed event — so what travels is
 *  the events themselves rather than frames with a terminal arm the protocol has not got. */
export type OpenAIImagesFrames = AsyncIterable<OpenAIImagesStreamEvent>;

/** OpenAI Images' own keys. They extend the shared space and never merge into it, so a stage
 *  written against the gateway alone cannot name one. */
export interface OpenAIImagesFacts extends GatewayFacts {
  /** Whether the client asked for the answer as a stream. It stays put, as every `ingress.*`
   *  key does: the same flag travels to the upstream inside the parameters, and the answer is
   *  written back in the shape it asked for. */
  'ingress.openaiImages.wantsStream': boolean;
  'request.openaiImages.canonical': CanonicalOpenAIImagesRequest;
  /** The answer, whichever kind it turned out to be. A stream, a value and a failure sit at
   *  one key: telling them apart is reading a value, and each stage does that where it needs
   *  to. */
  'response.openaiImages.canonical': CanonicalOpenAIImagesResponse | OpenAIImagesFrames | Failure;
  /** What the upstream will have reported by the time the events run out, and `null` on every
   *  path that does not stream. A streamed image states its usage in the completed event,
   *  which is after this run has answered — so the numbers cannot be in
   *  `response.usage.billable`, which says what had been reported when the ending stage handed
   *  up: the entity, and no quantities. Settling from this is the epilogue's job, after the
   *  drain. */
  'response.openaiImages.streamedUsage': Deferred<StreamOutcome> | null;
  /** What the client is actually sent, in the OpenAI Images protocol — a JSON body, or the SSE
   *  frames of a stream. The edge provides it, so a dump shows the body the client received
   *  rather than the gateway's canonical form. */
  'response.openaiImages.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
}

export type Fields<K extends keyof OpenAIImagesFacts> = { [P in K]: OpenAIImagesFacts[P] };

/** What a caller must bring. `ingress.http.headers`, `ingress.openaiImages.wantsStream` and
 *  `request.openaiImages.canonical` are in it although `compose` cannot derive them — the ending
 *  stage reads all three and a return-only stage declares no request side — so this type is the
 *  whole statement and `entryNeeds` is part of it. */
export type OpenAIImagesServeEntry = Fields<'ingress.http.headers' | 'ingress.openaiImages.wantsStream' | 'request.openaiImages.canonical' | 'serve.model'>;

export type OpenAIImagesServeExit = Fields<
  'response.openaiImages.rendered' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;
