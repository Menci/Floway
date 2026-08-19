// OpenAI Images as a pipeline. Two endpoints and one family: `generations` sends JSON and
// `edits` sends either JSON or a multipart form, so what the operation decides is the request
// fact and the provider method the ending calls, and the four stages are the same either way.
// Both endpoints accept `stream: true`, so the answer is a stream whenever the client asked for
// one — the same request field decides both what the upstream is asked for and what shape comes
// back.
//
//   emitOpenAIImages          the edge: serializes the answer into the OpenAI Images protocol,
//                             SSE framing included
//   resolveCandidates         narrows to the upstreams that expose this operation's endpoint
//   failover                  runs what follows once per candidate
//   callOpenAIImagesUpstream  the ending: dials, and provides what came back

import { recordStream, streamReferenceOf } from '../../dump/turn-dump.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import type { BillableEntity, Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates } from '../pipeline/stages.ts';
import { dialFailure, readUpstreamBody } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { compose, defer, defineStage, move, own, type Deferred, type Owned, type Pipeline } from '@floway-dev/pipeline';
import {
  eventFrame,
  isEventStreamMediaType,
  mediaTypeEssence,
  parseDecimalString,
  renderErrorEnvelope,
  upstreamErrorMessage,
  type ModelEndpointKey,
  type SseFrame,
} from '@floway-dev/protocols/common';
import {
  OPENAI_IMAGES_MISSING_TERMINAL_MESSAGE,
  openaiImagesStreamEventToSSEFrame,
  isOpenAIImagesTerminalEvent,
  parseOpenAIImagesResponse,
  parseOpenAIImagesStream,
  parseOpenAIImagesUsage,
  renderOpenAIImagesResponse,
  type CanonicalOpenAIImagesEditsRequest,
  type CanonicalOpenAIImagesRequest,
  type CanonicalOpenAIImagesResponse,
  type CanonicalOpenAIImagesUsage,
  type OpenAIImageEditReference,
  type OpenAIImagesEditImage,
  type OpenAIImagesOperation,
  type OpenAIImagesStreamEvent,
} from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl, providerModelOf } from '@floway-dev/provider';
import type { OpenAIImagesEditsRequest, OpenAIImagesEditsSource, ModelCandidate, PerformanceOperation, TelemetryModelIdentity } from '@floway-dev/provider';

/** The answer while it is still the upstream's, one event at a time. There is no transport
 *  sentinel below the events — this protocol ends at its completed event — so what travels is
 *  the events themselves rather than frames with a terminal arm the protocol has not got. */
export type OpenAIImagesFrames = AsyncIterable<OpenAIImagesStreamEvent>;

/** A stream as a value the record can hold, as a wrapper around the generator rather than the
 *  generator itself. What the wrapper says is where the resource is: the one resource in an
 *  OpenAI Images run is the upstream's body at `response.http.body`, claimed with `own()`, and
 *  this keeps a frame view from reading as another. */
const view = <T>(frames: AsyncGenerator<T>): AsyncIterable<T> => ({ [Symbol.asyncIterator]: () => frames });

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

type I<K extends keyof OpenAIImagesFacts> = { [P in K]: OpenAIImagesFacts[P] };

const ENDPOINT = {
  generations: 'openaiImagesGenerations',
  edits: 'openaiImagesEdits',
} as const satisfies Record<OpenAIImagesOperation, ModelEndpointKey>;

const PERFORMANCE_OPERATION = {
  generations: 'image_generation',
  edits: 'image_edit',
} as const satisfies Record<OpenAIImagesOperation, PerformanceOperation>;

const isFrames = (answer: CanonicalOpenAIImagesResponse | OpenAIImagesFrames): answer is OpenAIImagesFrames =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge. It names nothing on the way down — the family has one protocol, so there
 * is no request to read to know how to answer — and coming back it renders the answer, keeps
 * the upstream headers a client may see, and decides the status. The status is decided here
 * rather than carried up because a refusal that never reached an upstream has none to carry.
 *
 * SSE framing is produced here and nowhere else: below this stage a stream carries protocol
 * events, so the same assembly would serve another transport by rendering differently at this
 * one point.
 */
const emitOpenAIImages = defineStage<
  Record<string, never>,
  Record<string, never>,
  I<'response.openaiImages.canonical' | 'response.http.headers'>,
  I<'response.openaiImages.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAIImages',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.openaiImages.canonical', 'response.http.headers'],
      consumes: ['response.openaiImages.canonical', 'response.http.headers'],
      provides: ['response.openaiImages.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.openaiImages.canonical': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    return {
      ...rest,
      'response.http.headers': forwardable.length === headers.length ? headers : move(forwardable),
      'response.http.status': isFailure(answer) ? answer.status : 200,
      'response.openaiImages.rendered': move(rendered(answer)),
    };
  },
});

const rendered = (answer: OpenAIImagesFacts['response.openaiImages.canonical']): OpenAIImagesFacts['response.openaiImages.rendered'] =>
  isFailure(answer) ? renderErrorEnvelope(answer.message, answer.body)
    : isFrames(answer) ? renderSSE(answer)
      : renderOpenAIImagesResponse(answer);

const renderSSE = (frames: OpenAIImagesFrames): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const event of frames) yield openaiImagesStreamEventToSSEFrame(event);
  })(),
});

/**
 * The ending. It dials, reads what came back on the shape the request asked for, and provides
 * the canonical answer, the headers that came with it, the raw HTTP body beneath it, and what
 * the call is billable for. A failure is a value: an upstream that refused, and one that
 * answered with something this protocol cannot read, are both outcomes the fork above can take
 * to the next candidate rather than faults that end the run.
 */
const callOpenAIImagesUpstream = defineStage<
  I<'ingress.openaiImages.wantsStream' | 'request.openaiImages.canonical' | 'route.attempt' | 'ingress.http.headers'>,
  I<'response.openaiImages.canonical' | 'response.openaiImages.streamedUsage' | 'response.http.headers'
    | 'response.http.body' | 'response.usage.billable'>,
  GatewayServices
>({
  name: 'callOpenAIImagesUpstream',
  return: {
    provides: [
      'response.openaiImages.canonical',
      'response.openaiImages.streamedUsage',
      'response.http.headers',
      'response.http.body',
      'response.usage.billable',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const request = facts['request.openaiImages.canonical'];
    const options = buildUpstreamCallOptions(
      candidate,
      use.gateway,
      // The client's own headers reach the upstream from the record, not from a live request
      // object: what a provider is allowed to forward is filtered per provider, and the dump
      // shows what was there to filter.
      new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value])),
    );
    const model = providerModelOf(candidate);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, PERFORMANCE_OPERATION[request.operation]);

    let result;
    try {
      // No abort signal, as on this family's endpoints from the beginning: an image the upstream
      // has already begun is charged for whether or not the client waited for it, so dropping the
      // call would lose the usage reading and save nothing. Reading a stream is the other half of
      // that and does take the signal — what it drops there is a connection, not an image.
      result = request.operation === 'generations'
        ? await candidate.provider.instance.callOpenAIImagesGenerations(model, request.parameters, undefined, options)
        : await candidate.provider.instance.callOpenAIImagesEdits(model, providerEditsRequest(request), undefined, options);
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.openaiImages.canonical': dialFailure(error),
        'response.openaiImages.streamedUsage': null,
        'response.http.headers': [],
        'response.http.body': spentBody(null),
        'response.usage.billable': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // What came back, unfiltered: the edge is where a client's view of it is decided.
    const headers = [...result.response.headers];
    // An entity with no quantities is how "the upstream was called and reported nothing" is
    // said, which is a different situation from reporting zero.
    const called: readonly BillableEntity[] = [{ identity, quantities: {} }];
    const read = (canonical: CanonicalOpenAIImagesResponse | Failure, billable: readonly BillableEntity[]) => move({
      ...facts,
      'response.openaiImages.canonical': canonical,
      'response.openaiImages.streamedUsage': null,
      'response.http.headers': headers,
      'response.http.body': spentBody(result.response.body),
      'response.usage.billable': billable,
    });

    if (!result.response.ok) {
      use.log.warn('upstream refused', { status: result.response.status });
      // An upstream error body is JSON like any other body. Reading it here is also what
      // leaves a losing attempt with nothing open behind it.
      const body = await readUpstreamBody(result.response);
      return read({
        status: result.response.status,
        message: upstreamErrorMessage(body.json) ?? body.text,
        ...('json' in body ? { body: body.json } : {}),
      }, called);
    }

    const mediaType = result.response.headers.get('content-type');
    // Both halves have to hold. `stream` is what the client asked for, and an upstream that
    // ignores it answers the single JSON body the arm below reads — so what settles which
    // shape arrived is the media type, and what settles which shape the client is owed is the
    // request.
    if (facts['ingress.openaiImages.wantsStream'] && isEventStreamMediaType(mediaType)) {
      if (result.response.body === null) {
        return read({ status: 502, message: 'Upstream returned a streaming response with no body.' }, called);
      }
      // Usage is observed here, closest to the upstream and on the protocol it spoke, by
      // folding the events as they pass — so the reading costs one pass and the client's own
      // stream is what drives it. What it finds arrives with the completed event, long after
      // this stage has handed up, which is why the entity above carries no quantities.
      const metered = meterFrames(result.response.body, identity, use.gateway.abortSignal);
      return move({
        ...facts,
        // This protocol's stream is bare events rather than protocol frames, so the record is
        // told how one becomes a frame instead of being left to assume.
        'response.openaiImages.canonical': recordStream(metered.frames, use.gateway.dump, eventFrame),
        'response.openaiImages.streamedUsage': metered.outcome,
        'response.http.headers': headers,
        // Releasing this body is reading those events to the end: they are one reader over one
        // connection, and a second reader is not something a `ReadableStream` allows.
        'response.http.body': own(result.response.body, async (): Promise<void> => { for await (const _event of metered.frames) { /* to end of stream */ } }),
        'response.usage.billable': called,
      });
    }

    const body = await readUpstreamBody(result.response);
    if (!('json' in body)) {
      // Every protocol the gateway carries is one it fully understands, so a body it cannot
      // read is not handed on unread.
      const essence = mediaTypeEssence(mediaType) ?? 'no media type';
      use.log.warn('upstream answered with a body that is not JSON', { status: result.response.status, mediaType: essence });
      return read({
        status: 502,
        message: `The upstream answered ${result.response.status} with ${essence}, and the OpenAI Images protocol is JSON.`,
        body: body.text,
      }, called);
    }

    let canonical: CanonicalOpenAIImagesResponse;
    try {
      canonical = parseOpenAIImagesResponse(body.json);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      use.log.warn('upstream answered with a body the OpenAI Images protocol cannot read', { message });
      return read({ status: 502, message, body: body.json }, called);
    }
    return read(canonical, [{ identity, quantities: billed(canonical.usage) }]);
  },
});

/** A body this stage has already read to the end, or one the upstream never sent. The record
 *  holds a body as a stream and `failover` releases the losing attempts', so every path hands
 *  one up; what says an answer was unusable is the failure at the canonical key, not this. */
const spentBody = (body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> & Owned =>
  own(body ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() }), (): Promise<void> => Promise.resolve());

interface MeteredFrames {
  readonly frames: OpenAIImagesFrames;
  readonly outcome: Deferred<StreamOutcome>;
}

const meterFrames = (
  body: ReadableStream<Uint8Array>,
  identity: TelemetryModelIdentity,
  signal: AbortSignal | undefined,
): MeteredFrames => {
  let settle!: (outcome: StreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
  // Running out without the completed event is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const frames = view((async function* () {
    let usage: CanonicalOpenAIImagesUsage | undefined;
    try {
      for await (const event of parseOpenAIImagesStream(body, { signal })) {
        if (isOpenAIImagesTerminalEvent(event)) {
          usage = parseOpenAIImagesUsage(event);
          sawTerminal = true;
          yield event;
          // The image is complete, so there is nothing further to read. An upstream that holds
          // the connection open past this point would otherwise keep the client's own stream
          // open with it; returning here closes the read, which cancels the upstream.
          return;
        }
        yield event;
      }
    } finally {
      // Reached however the events ended — the completed one, a client that stopped reading,
      // or a broken upstream — because what the upstream already metered is billable whatever
      // happened to the downstream half.
      settle({ billable: [{ identity, quantities: billed(usage) }], failed: !sawTerminal });
    }
    // Only an upstream that ended its body without ever completing the image reaches here: the
    // arm above returns on the terminal event. A client has been sent partial images and no
    // image, which is a failed answer however far it got.
    throw new Error(OPENAI_IMAGES_MISSING_TERMINAL_MESSAGE);
  })());
  return { frames, outcome };
};

/** An image is billed by the tokens its upstream reports: `BILLING_METRICS` names no per-image
 *  or per-size unit, and per-size pricing is a selector coordinate rather than a metric, so
 *  there is nothing else here to record a count against. A reported zero is kept — it says the
 *  upstream reported, which an absent metric would not. */
const billed = (usage: CanonicalOpenAIImagesUsage | undefined): UsageQuantities => {
  const quantities: UsageQuantities = {};
  if (usage?.inputTokens !== undefined) quantities.input_tokens = parseDecimalString(String(usage.inputTokens));
  if (usage?.inputImageTokens !== undefined) quantities.input_image_tokens = parseDecimalString(String(usage.inputImageTokens));
  if (usage?.outputTokens !== undefined) quantities.output_tokens = parseDecimalString(String(usage.outputTokens));
  if (usage?.outputImageTokens !== undefined) quantities.output_image_tokens = parseDecimalString(String(usage.outputImageTokens));
  return quantities;
};

/** The provider's own shape, built where the dial happens. What it needs from a reference is
 *  whether the data URL inside it can become a file, because that decides whether the edit can
 *  ride as a multipart form; the canonical fact holds the reference the client wrote and leaves
 *  that question to the serializer that has it. */
const providerEditsRequest = (request: CanonicalOpenAIImagesEditsRequest): OpenAIImagesEditsRequest => ({
  images: request.images.map(providerEditsSource),
  ...(request.mask === undefined ? {} : { mask: providerEditsSource(request.mask) }),
  parameters: request.parameters,
});

const providerEditsSource = (image: OpenAIImagesEditImage): OpenAIImagesEditsSource => {
  if (image.kind === 'file') {
    return { type: 'upload', file: new File([image.file.bytes], image.file.fileName, { type: image.file.mediaType }) };
  }
  const { reference } = image;
  return typeof reference.image_url === 'string' && isBase64ImageDataUrl(reference.image_url)
    ? { type: 'inline', reference: reference as OpenAIImageEditReference & { image_url: string } }
    : { type: 'reference', reference };
};

/** A candidate that cannot serve *this* request is not a candidate. One family covers two
 *  endpoints and an upstream may expose either without the other, so which one is asked for is
 *  what narrows the list. */
const narrowing = (request: CanonicalOpenAIImagesRequest) => ({
  kind: 'image' as const,
  reject: (candidate: ModelCandidate) => candidate.model.endpoints[ENDPOINT[request.operation]] === undefined
    ? `the upstream does not expose the OpenAI Images ${request.operation} endpoint`
    : null,
  unsupported: (model: string) => `Model ${model} does not support the /images/${request.operation} endpoint.`,
  refuse: (status: number, message: string) => ({
    'response.openaiImages.canonical': { status, message } as Failure,
    'response.openaiImages.streamedUsage': null,
  }),
  refuses: ['response.openaiImages.canonical', 'response.openaiImages.streamedUsage'] as const,
});

/** What a caller must bring. `ingress.http.headers`, `ingress.openaiImages.wantsStream` and
 *  `request.openaiImages.canonical` are in it although `compose` cannot derive them — the ending
 *  stage reads all three and a return-only stage declares no request side — so this type is the
 *  whole statement and `entryNeeds` is part of it. */
export type OpenAIImagesServeEntry = I<'ingress.http.headers' | 'ingress.openaiImages.wantsStream' | 'request.openaiImages.canonical' | 'serve.model'>;

export type OpenAIImagesServeExit = I<
  'response.openaiImages.rendered' | 'response.openaiImages.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const openaiImagesServePipeline = (request: CanonicalOpenAIImagesRequest): Pipeline<OpenAIImagesServeEntry, OpenAIImagesServeExit> =>
  compose('openaiImagesServe', [
    emitOpenAIImages,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.openaiImages.canonical'?: unknown })['response.openaiImages.canonical']),
      handedUp => (handedUp as { 'response.openaiImages.streamedUsage'?: unknown })['response.openaiImages.streamedUsage'] !== null,
    ),
    resolveCandidates(narrowing(request)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.openaiImages.canonical'?: unknown })['response.openaiImages.canonical']),
      owns: ['response.http.body'],
    }),
    callOpenAIImagesUpstream,
  ]);
