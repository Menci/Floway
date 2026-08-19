// Text completions as a pipeline. One protocol, no translation, and an answer that is a
// stream whenever the client asked for one — the same request field decides both what the
// upstream is asked for and what shape comes back.
//
// The shape:
//
//   emitOpenAICompletions          the edge: asks the upstream for the usage chunk on the way
//                                  down, and renders the answer into the client's protocol on
//                                  the way back, SSE framing included
//   resolveCandidates              narrows to the upstreams that expose the endpoint
//   failover                       runs what follows once per candidate
//   callOpenAICompletionsUpstream  the ending: dials, parses what came back, and provides the
//                                  answer plus what is billable

import { tokenUsageFromOpenAICompletionsUsage } from './usage.ts';
import { recordStream, streamReferenceOf, type RunDump } from '../../dump/run-sink.ts';
import type { UsageQuantities } from '../../repo/types.ts';
import { tokenUsageQuantities } from '../../repo/usage-metrics.ts';
import type { BillableEntity, Failure, GatewayFacts } from '../pipeline/facts.ts';
import { isFailure } from '../pipeline/facts.ts';
import type { StreamOutcome } from '../pipeline/serve.ts';
import type { GatewayServices } from '../pipeline/services.ts';
import { writeSettlement } from '../pipeline/settlement.ts';
import { failover, resolveCandidates } from '../pipeline/stages.ts';
import { dialFailure } from '../pipeline/upstream-body.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../shared/upstream-response.ts';
import { compose, defer, defineStage, move, own, type Deferred, type Owned, type Pipeline } from '@floway-dev/pipeline';
import { isOpenAIUsageOnlyEventShape, renderErrorEnvelope, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  openaiCompletionsProtocolFrameToSSEFrame,
  parseOpenAICompletionsResult,
  parseOpenAICompletionsStream,
  type OpenAICompletionsPayload,
  type OpenAICompletionsResult,
  type OpenAICompletionsStreamEvent,
} from '@floway-dev/protocols/openai-completions';
import { providerModelOf } from '@floway-dev/provider';
import type { ModelCandidate, TelemetryModelIdentity } from '@floway-dev/provider';

/** The answer while it is still the upstream's, one frame at a time. */
export type OpenAICompletionsFrames = AsyncIterable<ProtocolFrame<OpenAICompletionsStreamEvent>>;

/**
 * A stream as a value the record can hold: a wrapper around the generator rather than the
 * generator itself, which is what says where the resource is. There is exactly one resource in
 * an OpenAI Completions run — the upstream's body, claimed with `own()` — and the wrapper keeps
 * a frame view from reading as another.
 *
 * What comes back is single-shot on purpose: a stream that has been read is a stream that is
 * over, and a second reader learns that rather than being lied to.
 */
const view = <T>(frames: AsyncGenerator<T>): AsyncIterable<T> => ({ [Symbol.asyncIterator]: () => frames });

/** OpenAI Completions' own keys, extending the shared space by intersection. */
export interface OpenAICompletionsFacts extends GatewayFacts {
  /** What the client asked for, which is not what the upstream is asked for: the gateway
   *  meters every stream and so always turns the usage chunk on. These stay put for the same
   *  reason every `ingress.*` key does — they describe the request that arrived, and the
   *  answer is rendered back into it. */
  'ingress.openaiCompletions.wantsStream': boolean;
  'ingress.openaiCompletions.wantsUsageChunk': boolean;
  'request.openaiCompletions.payload': OpenAICompletionsPayload;
  /** The answer, whichever kind it turned out to be. A stream, a value and a failure sit at
   *  one key: telling them apart is reading a value, and each stage does that where it needs
   *  to. */
  'response.openaiCompletions.payload': OpenAICompletionsResult | OpenAICompletionsFrames | Failure;
  /** What the upstream will have reported by the time the frames run out, and `null` on
   *  every path that does not stream. A stream's usage arrives with its last chunk, which is
   *  after this run has answered — so the numbers cannot be in `response.usage.billable`,
   *  which says what had been reported when the ending stage handed up: the entity, and no
   *  quantities. Settling billing from this is the prologue's job, after the drain. */
  'response.openaiCompletions.streamedUsage': Deferred<StreamOutcome> | null;
  /** What the client is actually sent, in its own protocol — a JSON body, or the SSE frames
   *  of a stream. The edge provides it, so a dump shows what the client received rather than
   *  the gateway's own reading of it. */
  'response.openaiCompletions.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
}

type C<K extends keyof OpenAICompletionsFacts> = { [P in K]: OpenAICompletionsFacts[P] };

const isFrames = (answer: OpenAICompletionsFacts['response.openaiCompletions.payload']): answer is OpenAICompletionsFrames =>
  Symbol.asyncIterator in answer;

/**
 * The outermost edge, and the only place where what the client asked for and what the
 * upstream is asked for differ: billing needs the usage chunk on every stream, so it is
 * turned on going down and taken back out coming up unless the client asked to see it.
 *
 * Rendering the answer is the other half. SSE framing is produced here and nowhere else —
 * below this stage a stream carries protocol frames, so the same assembly would serve
 * another transport by rendering differently at this one point.
 */
const emitOpenAICompletions = defineStage<
  C<'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload'>,
  C<'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload'>,
  C<'ingress.openaiCompletions.wantsUsageChunk' | 'response.openaiCompletions.payload' | 'response.http.headers'>,
  C<'response.openaiCompletions.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitOpenAICompletions',
  through: {
    request: {
      needs: ['ingress.openaiCompletions.wantsStream', 'ingress.openaiCompletions.wantsUsageChunk', 'request.openaiCompletions.payload'],
      consumes: [],
      provides: ['request.openaiCompletions.payload'],
    },
    response: {
      needs: ['response.openaiCompletions.payload', 'response.http.headers'],
      consumes: ['response.openaiCompletions.payload', 'response.http.headers'],
      provides: ['response.openaiCompletions.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const asked = facts['request.openaiCompletions.payload'];
    const back = await next({
      ...facts,
      'request.openaiCompletions.payload': move(facts['ingress.openaiCompletions.wantsStream']
        ? { ...asked, stream_options: { ...asked.stream_options, include_usage: true } }
        : asked),
    });

    const { 'response.openaiCompletions.payload': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    // A refusal keeps the status the upstream gave it. Anything that answered is a 200 the
    // gateway says itself, because what the client receives is serialized here rather than
    // relayed — the upstream's own status is a fact further down for whoever wants it.
    return {
      ...rest,
      'response.http.headers': forwardable.length === headers.length ? headers : move(forwardable),
      'response.http.status': isFailure(answer) ? answer.status : 200,
      'response.openaiCompletions.rendered': move(rendered(answer, back['ingress.openaiCompletions.wantsUsageChunk'])),
    };
  },
});

const rendered = (
  answer: OpenAICompletionsFacts['response.openaiCompletions.payload'],
  wantsUsageChunk: boolean,
): OpenAICompletionsFacts['response.openaiCompletions.rendered'] =>
  isFailure(answer) ? renderErrorEnvelope(answer.message, answer.body)
    : isFrames(answer) ? renderSSE(answer, wantsUsageChunk)
      : answer;

const renderSSE = (frames: OpenAICompletionsFrames, wantsUsageChunk: boolean): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      if (!wantsUsageChunk && frame.type === 'event' && isOpenAIUsageOnlyEventShape(frame.event)) continue;
      yield openaiCompletionsProtocolFrameToSSEFrame(frame);
    }
  })(),
});

/**
 * The ending. It dials, reads what came back on the shape the request asked for, and
 * provides the answer, the raw HTTP response beneath it, and what the call is billable for.
 * A failure is a value: a 429 here is what an earlier stage fails over, and so is a 200 whose
 * body this protocol cannot read, because the next candidate's path and flags may differ.
 */
const callOpenAICompletionsUpstream = defineStage<
  C<'ingress.openaiCompletions.wantsStream' | 'request.openaiCompletions.payload' | 'route.attempt' | 'ingress.http.headers'>,
  C<'response.openaiCompletions.payload' | 'response.openaiCompletions.streamedUsage' | 'response.usage.billable'
    | 'response.http.status' | 'response.http.headers' | 'response.http.body'>,
  GatewayServices
>({
  name: 'callOpenAICompletionsUpstream',
  return: {
    provides: [
      'response.openaiCompletions.payload',
      'response.openaiCompletions.streamedUsage',
      'response.usage.billable',
      'response.http.status',
      'response.http.headers',
      'response.http.body',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The provider re-stamps whatever id it resolved upstream, so the id the client
    // addressed does not travel with the body.
    const { model: _addressed, ...body } = facts['request.openaiCompletions.payload'];
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'text_completion');

    let result;
    try {
      result = await candidate.provider.instance.callOpenAICompletions(
        providerModelOf(candidate),
        body,
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
        'response.openaiCompletions.payload': dialFailure(error),
        'response.openaiCompletions.streamedUsage': null,
        'response.usage.billable': [],
        'response.http.status': 502,
        'response.http.headers': [],
        'response.http.body': spentBody(null),
      });
    }
    if (!result.response.ok) use.log.warn('upstream refused', { status: result.response.status });

    const answer = await readUpstream(
      result.response,
      facts['ingress.openaiCompletions.wantsStream'],
      telemetryModelIdentity(candidate, result.modelKey),
      candidate,
      use.gateway.abortSignal,
      use.gateway.dump,
    );
    return move({
      ...facts,
      'response.openaiCompletions.payload': answer.payload,
      'response.openaiCompletions.streamedUsage': answer.streamedUsage,
      'response.usage.billable': answer.billable,
      'response.http.status': result.response.status,
      'response.http.headers': [...result.response.headers],
      'response.http.body': answer.body,
    });
  },
});

interface UpstreamAnswer {
  readonly payload: OpenAICompletionsFacts['response.openaiCompletions.payload'];
  readonly streamedUsage: OpenAICompletionsFacts['response.openaiCompletions.streamedUsage'];
  readonly billable: readonly BillableEntity[];
  /** Every arm hands one up, this stage's own reading included: the record holds a body as a
   *  stream, and `failover` releases the losing attempts' by consuming that key. */
  readonly body: ReadableStream<Uint8Array> & Owned;
}

/** What the upstream said, on the shape the request asked for. Which of the four this is is
 *  read from the response, never declared: a stream, a value and a failure sit at one key. */
const readUpstream = async (
  response: Response,
  wantsStream: boolean,
  identity: TelemetryModelIdentity,
  candidate: ModelCandidate,
  signal: AbortSignal | undefined,
  dump: RunDump | null,
): Promise<UpstreamAnswer> => {
  // An upstream was called and reported nothing — which is what every arm but a read usage
  // block leaves standing, and is a different statement from reporting zero.
  const called: readonly BillableEntity[] = [{ identity, quantities: {} }];

  if (!response.ok) {
    // An upstream error body is JSON like any other body. Reading it here is also what
    // leaves a losing attempt with nothing open behind it.
    return { payload: await refusal(response), streamedUsage: null, billable: called, body: spentBody(response.body) };
  }

  if (!wantsStream) {
    const read = await readResult(response);
    return {
      payload: isFailure(read) ? read : read.value,
      streamedUsage: null,
      billable: isFailure(read) ? called : [{ identity, quantities: billed(read.value.usage, read.value.service_tier, candidate) }],
      body: spentBody(response.body),
    };
  }

  if (response.body === null) {
    return {
      payload: { status: 502, message: 'Upstream returned a streaming response with no body.' },
      streamedUsage: null,
      billable: called,
      body: spentBody(null),
    };
  }

  // Usage is observed here, closest to the upstream and on the protocol it spoke, by folding
  // the frames as they pass — so the reading costs one pass and the client's own stream is
  // what drives it. What it finds arrives with the last frame, long after this stage has
  // handed up, which is why the entity above carries no quantities.
  const metered = meterFrames(parseOpenAICompletionsStream(response.body, { signal }), identity, candidate);
  return {
    payload: recordStream(metered.frames, dump),
    streamedUsage: metered.outcome,
    billable: called,
    // Releasing this body is draining those frames: they are one reader over one connection,
    // and a second reader is not something a `ReadableStream` allows.
    body: own(response.body, async (): Promise<void> => { for await (const _frame of metered.frames) { /* to end of stream */ } }),
  };
};

/** A body this stage has already read to the end, or one the upstream never sent. The record
 *  holds a body as a stream and `failover` releases the losing attempts', so every path hands
 *  one up; what says an answer was unusable is the failure at the payload key, not this. */
const spentBody = (body: ReadableStream<Uint8Array> | null): ReadableStream<Uint8Array> & Owned =>
  own(body ?? new ReadableStream<Uint8Array>({ start: controller => controller.close() }), (): Promise<void> => Promise.resolve());

const refusal = async (response: Response): Promise<Failure> => {
  const text = await response.text();
  try {
    return { status: response.status, message: text, body: JSON.parse(text) as unknown };
  } catch {
    // A refusal that is not JSON is still a refusal, and its text is what the client is
    // told — as this protocol's own envelope, minted from the status and these words, because
    // a body this protocol cannot carry is not one to hand on.
    return { status: response.status, message: text };
  }
};

/** A body that answered 200 and cannot be read as this protocol is an attempt that failed,
 *  because the gateway serializes what it sends from the value it parsed and has nothing to
 *  serialize. The next candidate may well answer in the protocol it advertised. */
const readResult = async (response: Response): Promise<{ readonly value: OpenAICompletionsResult } | Failure> => {
  try {
    return { value: parseOpenAICompletionsResult(await response.json()) };
  } catch (error) {
    return { status: 502, message: `Upstream answered ${response.status} with a body this endpoint cannot read: ${error instanceof Error ? error.message : String(error)}` };
  }
};

interface MeteredFrames {
  readonly frames: OpenAICompletionsFrames;
  readonly outcome: Deferred<StreamOutcome>;
}

const meterFrames = (
  source: AsyncIterable<ProtocolFrame<OpenAICompletionsStreamEvent>>,
  identity: TelemetryModelIdentity,
  candidate: ModelCandidate,
): MeteredFrames => {
  let settle!: (outcome: StreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const frames = view((async function* () {
    let usage: unknown;
    let tier: string | null | undefined;
    try {
      for await (const frame of source) {
        if (frame.type === 'event') {
          // `service_tier` can ride on any chunk's root while the totals only land on the
          // usage-only one, so the two are tracked apart and settled together.
          const root = frame.event as { service_tier?: string | null; usage?: unknown };
          if (root.service_tier !== undefined) tier = root.service_tier;
          if (isOpenAIUsageOnlyEventShape(frame.event)) usage = root.usage;
        }
        // The transport's own terminator is this protocol's end-of-turn.
        if (frame.type === 'done') sawTerminal = true;
        yield frame;
      }
    } finally {
      // Reached however the frames ended — the terminal chunk, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [{ identity, quantities: billed(usage, tier, candidate) }], failed: !sawTerminal });
    }
  })());
  return { frames, outcome };
};

const billed = (usage: unknown, tier: string | null | undefined, candidate: ModelCandidate): UsageQuantities => {
  const model = providerModelOf(candidate);
  const tokens = tokenUsageFromOpenAICompletionsUsage(
    usage,
    tier,
    model.enabledFlags.has('usage-exclusive-cached-tokens'),
    `${candidate.provider.upstreamId}/${model.id}`,
  );
  // An upstream that reported nothing leaves no quantities at all, which is a different
  // statement from reporting zero.
  //
  // The service tier survives as far as `TokenUsage.tier` and no further: a billed entity is
  // an identity and a bag of quantities, and the pricing selector the tier feeds has no seat
  // there. It comes back when settlement does.
  return tokens === null ? {} : tokenUsageQuantities(tokens);
};

/** A candidate that cannot serve this endpoint is not a candidate. The resolver's own filter
 *  is by kind, and a text-completion model is a chat-kind model, so what is left to say is
 *  whether the upstream exposes the endpoint at all. */
const narrowing = {
  kind: 'chat' as const,
  reject: (candidate: ModelCandidate): string | null =>
    candidate.model.endpoints.openaiCompletions === undefined ? 'the upstream does not expose an OpenAI Completions endpoint' : null,
  unsupported: (model: string) => `Model ${model} does not support the /completions endpoint.`,
  refuse: (status: number, message: string): C<'response.openaiCompletions.payload' | 'response.openaiCompletions.streamedUsage'> => ({
    'response.openaiCompletions.payload': { status, message },
    'response.openaiCompletions.streamedUsage': null,
  }),
  refuses: ['response.openaiCompletions.payload', 'response.openaiCompletions.streamedUsage'] as const,
};

export const openaiCompletionsServePipeline: Pipeline<
  C<'ingress.http.headers' | 'ingress.openaiCompletions.wantsStream' | 'ingress.openaiCompletions.wantsUsageChunk' | 'request.openaiCompletions.payload' | 'serve.model'>,
  C<'response.openaiCompletions.rendered' | 'response.openaiCompletions.streamedUsage' | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'>
> = compose('openaiCompletionsServe', [
  emitOpenAICompletions,
  writeSettlement(
    handedUp => isFailure((handedUp as { 'response.openaiCompletions.payload'?: unknown })['response.openaiCompletions.payload']),
    handedUp => (handedUp as { 'response.openaiCompletions.streamedUsage'?: unknown })['response.openaiCompletions.streamedUsage'] !== null,
  ),
  resolveCandidates(narrowing),
  failover({
    failed: handedUp => isFailure((handedUp as { 'response.openaiCompletions.payload'?: unknown })['response.openaiCompletions.payload']),
    owns: ['response.http.body'],
  }),
  callOpenAICompletionsUpstream,
]);
