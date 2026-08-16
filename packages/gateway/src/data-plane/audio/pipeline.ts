// Audio transcription as a pipeline. The family whose answer is not one document but six:
// `response_format` picks between three JSON objects and three text documents, `stream`
// picks a sequence of events instead of any of them, and each is its own media type. That
// is the whole reason this endpoint needed a response strategy of its own, and it is what
// one canonical fact plus one media-type fact dissolve.
//
// The shape:
//
//   emitAudioTranscription           the edge: writes the answer back in the rendering the
//                                    client asked for, SSE framing included
//   resolveCandidates                narrows to the upstreams that expose the endpoint
//   failover                         runs what follows once per candidate
//   callAudioTranscriptionUpstream   the ending: dials, reads what came back, and provides
//                                    the answer plus what is billable

import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity, Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates } from '../pipeline/stages.ts';
import { dialFailure } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { compose, defineStage, move, own, type Logger, type Owned, type Pipeline } from '@floway-dev/pipeline';
import {
  isAudioTranscriptionDoneEvent,
  parseAudioTranscription,
  parseAudioTranscriptionStreamEvent,
  parseAudioTranscriptionStreamUsage,
  parseAudioTranscriptionUsage,
  renderAudioTranscription,
  type AudioTranscriptionResponseFormat,
  type AudioTranscriptionStreamEvent,
  type AudioTranscriptionUsage,
  type CanonicalAudioTranscription,
} from '@floway-dev/protocols/audio';
import { isEventStreamMediaType, parseDecimalString, parseSSEStream, renderErrorEnvelope, sseFrame, type SseFrame } from '@floway-dev/protocols/common';
import { providerModelOf, type AudioTranscriptionFormEntry, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';

/** The answer while it is still the upstream's, one event at a time. It is a view and not a
 *  resource: what owns the connection is `response.http.body`, which is where release and
 *  failover's ownership both read.
 *
 *  A view has to be built as a wrapper around the generator rather than handed over as the
 *  generator itself. Measured on Node 24: `Symbol.asyncDispose in (async function*(){})()`
 *  is `true`, so a bare generator in the record is a releasable — the runner would adopt it,
 *  the top-level sweep would call its `return()`, and that cancels the iteration instead of
 *  draining it, which is the one thing release must never mean. */
export type AudioTranscriptionEvents = AsyncIterable<AudioTranscriptionStreamEvent>;

const viewOf = <T>(events: AsyncGenerator<T>): AsyncIterable<T> => ({ [Symbol.asyncIterator]: () => events });

/** What settling this run will be told once the events run out: what the upstream metered,
 *  and whether the transcript ever finished. */
export interface AudioTranscriptionStreamOutcome {
  readonly billable: readonly BillableEntity[];
  /** An upstream that stopped before `transcript.text.done` answered 200 and then did not
   *  finish what it started, which is a failed request however much of the transcript
   *  reached the client — the same reading the replaced surface made. */
  readonly failed: boolean;
}

/** Audio transcription's own keys, extending the shared space by intersection. */
export interface AudioTranscriptionFacts extends GatewayFacts {
  /** Which of the six renderings the client asked for. It belongs to the ingress and stays
   *  put: the same value travels to the upstream inside the form, so the rendering the
   *  answer arrives in is the rendering the answer is written back in — and a text document
   *  does not say which of the three it is, so nothing else could decide. */
  'ingress.audioTranscription.responseFormat': AudioTranscriptionResponseFormat;
  /** The multipart form as ordered semantic entries. The body is parsed before routing
   *  because field order is unconstrained, and every candidate builds a fresh body from
   *  these, so a retry never reuses a consumed one. The bytes the client sent are recorded
   *  at `ingress.http.body`, which is where a dump reads the upload itself. */
  'request.audioTranscription.form': readonly AudioTranscriptionFormEntry[];
  /** The one transcription, whichever rendering carried it — or the events it is arriving
   *  as, or the failure that came instead. A stream, a value and a failure sit at one key:
   *  telling them apart is reading a value, and each stage does that where it needs to. */
  'response.audioTranscription.canonical': CanonicalAudioTranscription | AudioTranscriptionEvents | Failure;
  /** What the answer goes out under. A media type is upstream-owned — OpenAI answers
   *  `text`, `srt` and `vtt` under one media type and other upstreams label them apart, and
   *  the document beneath it is the upstream's own either way — so the upstream's travels,
   *  and the edge names one only where the gateway wrote the body out of nothing the
   *  upstream sent. `null` is an upstream that declared none, and it stays `null`: labelling
   *  a body nobody described is a statement this gateway has no grounds to make. */
  'response.audioTranscription.mediaType': string | null;
  /** What the stream will have come to by the time the events run out, and `null` on every
   *  path that does not stream. A streamed transcription states its usage in the terminal
   *  event, which is after this run has answered — so the numbers cannot be in
   *  `response.usage.billable`, which says what had been reported when the ending stage
   *  handed up: the entity, and no quantities. Settling from this is the epilogue's job,
   *  after the drain. */
  'response.audioTranscription.streamedOutcome': Promise<AudioTranscriptionStreamOutcome> | null;
  /** What the client is actually sent — a JSON object, the upstream's own document, or the
   *  SSE frames of a stream. The edge provides it, so a dump shows what the client received
   *  rather than the gateway's own reading of it. */
  'response.audioTranscription.rendered': Record<string, unknown> | Uint8Array | AsyncIterable<SseFrame>;
}

type A<K extends keyof AudioTranscriptionFacts> = { [P in K]: AudioTranscriptionFacts[P] };

const isEvents = (answer: CanonicalAudioTranscription | AudioTranscriptionEvents): answer is AudioTranscriptionEvents =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge. Writes the answer back in the rendering the client asked for, and names
 * a media type for the one body the gateway wrote out of nothing the upstream sent — its
 * error envelope. Every other answer goes out under the media type it arrived with, because
 * for a document that is carried rather than rewritten the upstream's label is the only true
 * description there is.
 *
 * SSE framing is produced here and nowhere else — below this stage the answer is parsed
 * events, so the same assembly would serve another transport by rendering differently at
 * this one point. The upstream's own `event:` label is not carried: it is transport, and
 * OpenAI's clients read this endpoint's frames by their payload's `type` rather than by the
 * label. https://github.com/openai/openai-python/blob/10ee3f0da2ac6f93345c1204bd7bb1a2faa79ff2/src/openai/_streaming.py#L61-L107
 */
const emitAudioTranscription = defineStage<
  A<'ingress.audioTranscription.responseFormat'>,
  A<'ingress.audioTranscription.responseFormat'>,
  A<'ingress.audioTranscription.responseFormat' | 'response.audioTranscription.canonical' | 'response.audioTranscription.mediaType'>
    & { 'response.http.headers': readonly (readonly [string, string])[] },
  A<'response.audioTranscription.rendered' | 'response.audioTranscription.mediaType'>
    & { 'response.http.status': number; 'response.http.headers': readonly (readonly [string, string])[] }
>({
  name: 'emitAudioTranscription',
  through: {
    request: {
      needs: ['ingress.audioTranscription.responseFormat'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.audioTranscription.canonical', 'response.audioTranscription.mediaType', 'response.http.headers'],
      consumes: ['response.audioTranscription.canonical', 'response.http.headers'],
      provides: ['response.audioTranscription.rendered', 'response.audioTranscription.mediaType', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.audioTranscription.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.http.status': answer.status,
        'response.audioTranscription.mediaType': 'application/json',
        'response.audioTranscription.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
      };
    }
    // Everything that reaches here answered. The same key carried the upstream's own status
    // further down; re-providing it is what makes the top of the record the response the
    // client gets rather than the one the upstream gave.
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.http.status': 200,
      'response.audioTranscription.rendered': move(isEvents(answer)
        ? renderSSE(answer)
        : renderAudioTranscription(back['ingress.audioTranscription.responseFormat'], answer)),
    };
  },
});

const renderSSE = (events: AudioTranscriptionEvents): AsyncIterable<SseFrame> =>
  viewOf((async function* () {
    for await (const event of events) yield sseFrame(JSON.stringify(event));
  })());

/**
 * The ending. It dials, reads what came back in the rendering the request asked for, and
 * provides the answer, the raw HTTP response beneath it, and what the call is billable for.
 * A failure is a value: a 429 here is what an earlier stage fails over, and so is a dial that
 * never reached anyone. A 200 is never one of them — this endpoint carries the document the
 * upstream sent rather than serializing one from what it read, so a body no reading could
 * open is still that upstream's answer and there is nothing to try the next candidate for.
 */
const callAudioTranscriptionUpstream = defineStage<
  A<'ingress.audioTranscription.responseFormat' | 'request.audioTranscription.form' | 'route.attempt' | 'ingress.http.headers'>,
  A<'response.audioTranscription.canonical' | 'response.audioTranscription.mediaType' | 'response.audioTranscription.streamedOutcome'>
    & { 'response.usage.billable': readonly BillableEntity[]; 'response.http.status': number;
      'response.http.headers': readonly (readonly [string, string])[];
      'response.http.body': ReadableStream<Uint8Array> & Owned; },
  GatewayServices
>({
  name: 'callAudioTranscriptionUpstream',
  return: {
    provides: [
      'response.audioTranscription.canonical',
      'response.audioTranscription.mediaType',
      'response.audioTranscription.streamedOutcome',
      'response.usage.billable',
      'response.http.status',
      'response.http.headers',
      'response.http.body',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'audio_transcription');

    let result;
    try {
      result = await candidate.provider.instance.callAudioTranscriptions(
        providerModelOf(candidate),
        { entries: facts['request.audioTranscription.form'] },
        use.gateway.abortSignal,
        // The client's own headers reach the upstream from the record, not from a live request
        // object: what a provider is allowed to forward is filtered per provider, and the dump
        // shows what was there to filter.
        buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]))),
      );
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.audioTranscription.canonical': dialFailure(error),
        'response.audioTranscription.mediaType': null,
        'response.audioTranscription.streamedOutcome': null,
        'response.usage.billable': [],
        'response.http.status': 502,
        'response.http.headers': [],
        'response.http.body': spentBody(null),
      });
    }
    const identity = telemetryModelIdentity(candidate, result.modelKey);
    const format = facts['ingress.audioTranscription.responseFormat'];
    const status = result.response.status;
    const mediaType = result.response.headers.get('content-type');
    const headers = move([...result.response.headers] as readonly (readonly [string, string])[]);
    // An upstream that was called and reported nothing is a different situation from one
    // that reported zero, so the entity is present with no quantities.
    const called: readonly BillableEntity[] = [{ identity, quantities: {} }];

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status });
      // An upstream error body is JSON like any other body, and reading it here is also what
      // leaves a losing attempt with nothing open behind it.
      return move({
        ...facts,
        'response.audioTranscription.canonical': await refusal(status, result.response),
        'response.audioTranscription.mediaType': mediaType,
        'response.audioTranscription.streamedOutcome': null,
        'response.usage.billable': called,
        'response.http.status': status,
        'response.http.headers': headers,
        'response.http.body': spentBody(result.response.body),
      });
    }

    // A streamed answer is the one the client asked for with `stream`, and it is the media
    // type that says one arrived: an upstream that ignores `stream` — `whisper-1` does —
    // answers in the rendering `response_format` named instead.
    // https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L36325-L36336
    if (isEventStreamMediaType(mediaType)) {
      if (result.response.body === null) {
        return move({
          ...facts,
          'response.audioTranscription.canonical': { status: 502, message: 'Upstream returned a streaming response with no body.' },
          'response.audioTranscription.mediaType': mediaType,
          'response.audioTranscription.streamedOutcome': null,
          'response.usage.billable': called,
          'response.http.status': status,
          'response.http.headers': headers,
          'response.http.body': spentBody(null),
        });
      }
      // What the upstream metered, and whether the transcript finished, are both observed
      // here — closest to the upstream and on the protocol it spoke — by folding the events
      // as they pass, so the reading costs one pass and the client's own stream drives it.
      const metered = meterEvents(result.response.body, identity, use.gateway.abortSignal, use.log);
      return move({
        ...facts,
        'response.audioTranscription.canonical': metered.events,
        'response.audioTranscription.mediaType': mediaType,
        'response.audioTranscription.streamedOutcome': metered.outcome,
        'response.usage.billable': called,
        'response.http.status': status,
        'response.http.headers': headers,
        // Releasing this body is reading those events to the end: they are one reader over
        // one connection, and a second reader is not something a `ReadableStream` allows.
        'response.http.body': own(result.response.body, async (): Promise<void> => { for await (const _event of metered.events) { /* to end of stream */ } }),
      });
    }

    // A 2xx body is the answer whether or not this endpoint could read it, because what the
    // client is sent is the document that arrived and not something serialized from a parse.
    // So there is nothing here to fail over from: the reading feeds the record and the usage
    // row, and the bytes travel either way.
    const read = readTranscription(format, new Uint8Array(await result.response.arrayBuffer()), use.log);
    return move({
      ...facts,
      'response.audioTranscription.canonical': read.canonical,
      'response.audioTranscription.mediaType': mediaType,
      'response.audioTranscription.streamedOutcome': null,
      'response.usage.billable': [{ identity, quantities: billed(read.usage) }],
      'response.http.status': status,
      'response.http.headers': headers,
      'response.http.body': spentBody(result.response.body),
    });
  },
});

/** A body this stage has already read to the end, or one the upstream never sent. The record
 *  holds a body as a stream and `failover` releases the losing attempts', so every path hands
 *  one up; what says an answer was unusable is the failure at the canonical key, not this. */
const spentBody = (body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> & Owned =>
  own(body ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() }), (): Promise<void> => Promise.resolve());

const refusal = async (status: number, response: Response): Promise<Failure> => {
  const text = await response.text();
  try {
    return { status, message: text, body: JSON.parse(text) as unknown };
  } catch {
    // A refusal that is not JSON is still a refusal, and its text is what the client is
    // told; there is simply no parsed body for a dump reader to open.
    return { status, message: text };
  }
};

/**
 * What a 2xx body was worth to this endpoint, in two readings that do not depend on each
 * other.
 *
 * Neither can cost the client the answer: the document is carried, so a body no reading
 * could open is still what goes back, and what a failed reading costs is the transcript in
 * the record and whatever usage the body would have stated. Nor can either cost the other —
 * an upstream whose usage block this gateway cannot model still had its transcript read, and
 * one whose document it could not open is still billed for nothing rather than mis-billed.
 */
const readTranscription = (
  format: AudioTranscriptionResponseFormat,
  document: Uint8Array,
  log: Logger,
): { readonly canonical: CanonicalAudioTranscription; readonly usage: AudioTranscriptionUsage | undefined } => {
  let canonical: CanonicalAudioTranscription;
  try {
    canonical = parseAudioTranscription(format, document);
  } catch (error) {
    log.warn('failed to parse 2xx upstream body for /audio/transcriptions; forwarding it as it arrived', { error: String(error) });
    return { canonical: { document }, usage: undefined };
  }
  // Only an object rendering states usage: `text`, `srt` and `vtt` have nowhere to put it,
  // and asking them for one is what would warn about every subtitle a client requests.
  return { canonical, usage: canonical.raw === undefined ? undefined : readUsage(() => parseAudioTranscriptionUsage(canonical.raw), log) };
};

/** A transcription states its usage in two places — the body of an object rendering and the
 *  terminal event of a stream — and either can state it in a shape this gateway cannot read.
 *  That upstream metered something, and the request is recorded saying exactly that: the
 *  entity, and no quantities. */
const readUsage = (read: () => AudioTranscriptionUsage | undefined, log: Logger): AudioTranscriptionUsage | undefined => {
  try {
    return read();
  } catch (error) {
    log.warn('invalid usage in 2xx upstream response; recording the request only', { error: String(error) });
    return undefined;
  }
};

interface MeteredEvents {
  readonly events: AudioTranscriptionEvents;
  readonly outcome: Promise<AudioTranscriptionStreamOutcome>;
}

const meterEvents = (
  body: ReadableStream<Uint8Array>,
  identity: TelemetryModelIdentity,
  signal: AbortSignal | undefined,
  log: Logger,
): MeteredEvents => {
  let settle!: (outcome: AudioTranscriptionStreamOutcome) => void;
  const outcome = new Promise<AudioTranscriptionStreamOutcome>(resolve => { settle = resolve; });
  const events = viewOf((async function* () {
    let usage: AudioTranscriptionUsage | undefined;
    let completed = false;
    try {
      for await (const frame of parseSSEStream(body, { signal })) {
        const event = parseAudioTranscriptionStreamEvent(JSON.parse(frame.data) as unknown);
        if (isAudioTranscriptionDoneEvent(event)) {
          usage = readUsage(() => parseAudioTranscriptionStreamUsage(event), log);
          completed = true;
          yield event;
          // The transcript is complete, so there is nothing further to read. An upstream that
          // holds the connection open past this point would otherwise keep the client's own
          // stream open with it; returning here closes the read, which cancels the upstream.
          return;
        }
        yield event;
      }
    } finally {
      // Reached however the events ended — the terminal one, a client that stopped reading,
      // or a broken upstream — because what the upstream already metered is billable
      // whatever happened to the downstream half.
      settle({ billable: [{ identity, quantities: billed(usage) }], failed: !completed });
    }
  })());
  return { events, outcome };
};

const billed = (usage: AudioTranscriptionUsage | undefined): UsageQuantities => {
  if (usage === undefined) return {};
  if (usage.kind === 'duration') return { input_audio_seconds: parseDecimalString(String(usage.seconds)) };
  // Audio input is priced apart from text input, so what stays on the general input metric is
  // what the upstream did not attribute to audio.
  return {
    input_tokens: parseDecimalString(String(usage.inputTokens - (usage.inputAudioTokens ?? 0))),
    ...(usage.inputAudioTokens === undefined ? {} : { input_audio_tokens: parseDecimalString(String(usage.inputAudioTokens)) }),
    output_tokens: parseDecimalString(String(usage.outputTokens)),
  };
};

/** Nothing about this request narrows a candidate further. A transcription's parameters are
 *  form fields the upstream reads for itself, and no endpoint metadata says which renderings
 *  a model can write — so exposing the endpoint is the whole of the test. */
const narrowing = {
  kind: 'transcription' as const,
  reject: (candidate: ModelCandidate): string | null =>
    candidate.model.endpoints.audioTranscriptions === undefined
      ? 'the upstream does not expose an audio transcription endpoint'
      : null,
  unsupported: (model: string) => `Model ${model} does not support the /audio/transcriptions endpoint.`,
  refuse: (status: number, message: string) => ({
    'response.audioTranscription.canonical': { status, message } as Failure,
    'response.audioTranscription.mediaType': null,
    'response.audioTranscription.streamedOutcome': null,
  }),
  refuses: [
    'response.audioTranscription.canonical',
    'response.audioTranscription.mediaType',
    'response.audioTranscription.streamedOutcome',
  ] as const,
};

export const audioTranscriptionServePipeline: Pipeline<
  A<'ingress.http.headers' | 'ingress.audioTranscription.responseFormat' | 'request.audioTranscription.form' | 'serve.model'>,
  A<'response.audioTranscription.rendered' | 'response.audioTranscription.mediaType' | 'response.audioTranscription.streamedOutcome'>
  & { 'response.http.status': number; 'response.usage.billable': readonly BillableEntity[];
    'response.http.headers': readonly (readonly [string, string])[]; }
> = compose('audioTranscriptionServe', [
  emitAudioTranscription,
  writeSettlement(
    handedUp => isFailure((handedUp as { 'response.audioTranscription.canonical'?: unknown })['response.audioTranscription.canonical']),
    handedUp => (handedUp as { 'response.audioTranscription.streamedOutcome'?: unknown })['response.audioTranscription.streamedOutcome'] !== null,
  ),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.audioTranscription.canonical'?: unknown })['response.audioTranscription.canonical']),
    owns: ['response.http.body'],
  }),
  callAudioTranscriptionUpstream,
]);
