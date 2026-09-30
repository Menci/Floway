import type { BillableEntity, GatewayFacts, Failure } from '../pipeline/facts.ts';
import type { Deferred } from '@floway-dev/pipeline';
import type { SseFrame } from '@floway-dev/protocols/common';
import type { OpenAIAudioTranscriptionResponseFormat, CanonicalOpenAIAudioTranscription } from '@floway-dev/protocols/openai-audio';
import type { OpenAIAudioTranscriptionFormEntry } from '@floway-dev/provider';

/** The answer while it is still the upstream's, one event at a time. It is a view and not a
 *  resource: what owns the connection is `response.http.body`, which is where release and
 *  failover's ownership both read.
 *
 *  A view is a wrapper around the generator rather than the generator itself, which is what
 *  says where the resource is: the upstream's body at `response.http.body`, claimed with
 *  `own()`, and nothing else here. */
export type OpenAIAudioTranscriptionEvents = AsyncIterable<SseFrame>;

/** What settling this run will be told once the events run out: what the upstream metered,
 *  and whether the transcript ever finished. */
export interface OpenAIAudioTranscriptionStreamOutcome {
  readonly billable: readonly BillableEntity[];
  /** An upstream that stopped before `transcript.text.done` answered 200 and then did not
   *  finish what it started, which is a failed request however much of the transcript
   *  reached the client. */
  readonly failed: boolean;
}

/** OpenAI Audio Transcriptions' own keys, extending the shared space by intersection. */
export interface OpenAIAudioTranscriptionFacts extends GatewayFacts {
  /** Which of the six renderings the client asked for. It belongs to the ingress and stays
   *  put: the same value travels to the upstream inside the form, so the rendering the
   *  answer arrives in is the rendering the answer is written back in — and a text document
   *  does not say which of the three it is, so nothing else could decide. */
  'ingress.openaiAudioTranscription.responseFormat': OpenAIAudioTranscriptionResponseFormat;
  /** The multipart form as ordered semantic entries. The body is parsed before routing
   *  because field order is unconstrained, and every candidate builds a fresh body from
   *  these, so a retry never reuses a consumed one. The bytes the client sent are recorded
   *  at `ingress.http.body`, which is where a dump reads the upload itself. */
  'request.openaiAudioTranscription.form': readonly OpenAIAudioTranscriptionFormEntry[];
  /** The one transcription, whichever rendering carried it — or the events it is arriving
   *  as, or the failure that came instead. A stream, a value and a failure sit at one key:
   *  telling them apart is reading a value, and each stage does that where it needs to. */
  'response.openaiAudioTranscription.canonical': CanonicalOpenAIAudioTranscription | OpenAIAudioTranscriptionEvents | Failure;
  /** What the answer goes out under. A media type is upstream-owned — OpenAI answers
   *  `text`, `srt` and `vtt` under one media type and other upstreams label them apart, and
   *  the document beneath it is the upstream's own either way — so the upstream's travels,
   *  and the edge names one only where the gateway wrote the body out of nothing the
   *  upstream sent. `null` is an upstream that declared none, and it stays `null`: labelling
   *  a body nobody described is a statement this gateway has no grounds to make. */
  'response.openaiAudioTranscription.mediaType': string | null;
  /** What the stream will have come to by the time the events run out, and `null` on every
   *  path that does not stream. A streamed transcription states its usage in the terminal
   *  event, which is after this run has answered — so the numbers cannot be in
   *  `response.usage.billable`, which says what had been reported when the ending stage
   *  handed up: the entity, and no quantities. Settling from this is the epilogue's job,
   *  after the drain. */
  'response.openaiAudioTranscription.streamedOutcome': Deferred<OpenAIAudioTranscriptionStreamOutcome> | null;
  /** What the client is actually sent — a JSON object, the upstream's own document, or the
   *  SSE frames of a stream. The edge provides it, so a dump shows what the client received
   *  rather than the gateway's own reading of it. */
  'response.openaiAudioTranscription.rendered': Record<string, unknown> | Uint8Array | AsyncIterable<SseFrame>;
}

export type Fields<K extends keyof OpenAIAudioTranscriptionFacts> = { [P in K]: OpenAIAudioTranscriptionFacts[P] };
