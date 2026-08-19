// OpenAI Chat Completions as a pipeline — the reference chain for the chat families.
//
//   emitOpenAIChatCompletions  the edge: writes the answer in the shape the client asked for
//   writeSettlement            above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates      narrows to what can serve, in the order affinity asks for
//   failover                   runs what follows once per candidate
//   materializeAttempt         puts the payload this candidate is owed into the record
//   dialChatWire               the ending: picks this candidate's wire and hands into it
//
// The wire a candidate is dialled on is chosen per candidate rather than at assembly, and
// because failover re-runs the whole suffix the next candidate re-picks its own. Its own
// wire is a bare ending; the two translated ones are a handoff and then that protocol's own
// wire, and all three hand up `response.chat.openaiChatCompletions` — so the stage above cannot
// tell which ran.
//
// What sits *in* a wire rather than above the fork is the other half of the arrangement. A
// rule that speaks about an upstream's OpenAI Chat Completions endpoint — the role rewrite does,
// and position is what says so, because a stage below the fork runs only on the wire it chose —
// belongs to the wire and not to the source chain, so a turn that leaves for another
// protocol never carries it. Said by position rather than by a guard: a stage below the fork
// runs only when this is the wire the fork chose.

import { wrapOpenAIChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure, renderFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { anthropicMessagesWire } from '../anthropic-messages/pipeline.ts';
import type { ChatFacts } from '../facts.ts';
import { dialChatWire, handOff, type ChatWire } from '../handoff.ts';
import { meterChatWire } from '../meter.ts';
import { openaiResponsesWire } from '../openai-responses/pipeline.ts';
import {
  applyRoleCompatibilityToOpenAIChatCompletions,
  disableReasoningOnForcedToolChoiceForOpenAIChatCompletions,
  includeUsageStreamOptionsForOpenAIChatCompletions,
  normalizeExclusiveCachedTokensForOpenAIChatCompletions,
  normalizeUsageForOpenAIChatCompletions,
  stripPromptCacheKeyForOpenAIChatCompletions,
  vendorDeepSeekNormalizeForOpenAIChatCompletions,
  vendorKimiNormalizeForOpenAIChatCompletions,
  vendorQwenNormalizeForOpenAIChatCompletions,
} from '../rules.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defer, defineStage, move, type Deferred, type Pipeline, type Stage, type Use } from '@floway-dev/pipeline';
import type { BillableUsage, ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import {
  OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE,
  openaiChatCompletionsErrorPayloadMessage,
  openaiChatCompletionsProtocolFrameToSSEFrame,
  collectOpenAIChatCompletionsProtocolEventsToResult,
  type OpenAIChatCompletionsPayload,
  type OpenAIChatCompletionsStreamEvent,
} from '@floway-dev/protocols/openai-chat-completions';
import { providerModelOf, type ChatTargetApi, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateOpenAIChatCompletionsViaAnthropicMessages, translateOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

/** `/v1/chat/completions` prefers its own wire, then the translated Anthropic Messages path,
 *  then the translated OpenAI Responses path. */
export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

/** What this family adds to the chat space. */
export interface OpenAIChatCompletionsFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.openaiChatCompletions.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.openaiChatCompletions.streamedUsage': Deferred<StreamOutcome> | null;
}

type C<K extends keyof OpenAIChatCompletionsFacts> = { [P in K]: OpenAIChatCompletionsFacts[P] };

/**
 * The outermost edge. A chat answer is always a stream by the time it reaches here — the
 * upstream speaks SSE whatever the client asked for — so what this decides is whether the
 * client sees the frames or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
const emitOpenAIChatCompletions = defineStage<
  C<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'>,
  C<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'>,
  C<'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'
    | 'response.chat.openaiChatCompletions' | 'response.http.headers'>,
  C<'response.chat.openaiChatCompletions.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitOpenAIChatCompletions',
  through: {
    request: {
      needs: ['ingress.chat.openaiChatCompletions.wantsStream', 'ingress.chat.openaiChatCompletions.wantsUsageChunk'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.openaiChatCompletions', 'response.http.headers'],
      consumes: ['response.chat.openaiChatCompletions', 'response.http.headers'],
      provides: ['response.chat.openaiChatCompletions.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiChatCompletions': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(renderFailure(
          answer,
          () => ({ error: { message: answer.message, type: 'api_error' } }),
        )),
        'response.http.status': answer.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordStream(
      wrapOpenAIChatCompletionsAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.openaiChatCompletions.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.openaiChatCompletions.rendered': move(
          await collectOpenAIChatCompletionsProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.openaiChatCompletions.rendered': move(renderSSE(frames, back['ingress.chat.openaiChatCompletions.wantsUsageChunk'])),
      'response.http.status': 200,
    };
  },
});

/** Metering asks the upstream for a usage chunk on every streaming turn; whether the client
 *  is shown it is the client's own question. The protocol owns which frame that is, and says
 *  so by writing no frame at all. */
const renderSSE = (
  frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  includeUsageChunk: boolean,
): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = openaiChatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (written !== null) yield written;
    }
  })(),
});

/**
 * The wire. It dials OpenAI Chat Completions and provides the answer at whichever family's response
 * key the chain above it reads — which is what makes it interchangeable with a translated
 * chain: both hand up `response.chat.openaiChatCompletions`, and the stage above cannot tell which
 * ran.
 *
 * What it hands up is the upstream's own frames, unread. The reading is taken at the top of the
 * wire, above every rule that rewrites them, so nothing here has the means to produce a figure
 * the client will not be shown.
 */
const callOpenAIChatCompletionsUpstream = defineStage<
  C<'request.chat.openaiChatCompletions' | 'route.attempt' | 'ingress.http.headers'>,
  C<'response.chat.openaiChatCompletions' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callOpenAIChatCompletionsUpstream',
  return: {
    provides: [
      'response.chat.openaiChatCompletions',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    // What the record holds by now: the payload affinity materialized for this candidate,
    // as every stage between the fork and here has rewritten it — or, on a translated wire,
    // what the handoff put here.
    const body = bodyForAttempt(facts['request.chat.openaiChatCompletions'], candidate, applyRulesToUpstreamOpenAIChatCompletions);

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIChatCompletions(
        providerModelOf(candidate),
        body,
        use.gateway.abortSignal,
        // The client's own headers reach the upstream from the record, not from a live
        // request object: what a provider is allowed to forward is filtered per provider,
        // and the dump shows what was there to filter.
        buildUpstreamCallOptions(candidate, use.gateway, new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]))),
      );
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.chat.openaiChatCompletions': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
    // An upstream that was called and reported nothing, which is a different statement from
    // reporting zero.
    const called: readonly BillableEntity[] = [{ identity, quantities: {} }];

    if (!result.ok) {
      const text = await result.response.text();
      use.log.warn('upstream refused', { status: result.response.status });
      let parsed: unknown;
      try { parsed = JSON.parse(text) as unknown; } catch { parsed = undefined; }
      return move({
        ...facts,
        'response.chat.openaiChatCompletions': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state
    // must come back to.
    use.selectAffinity(candidate);
    return move({
      ...facts,
      'response.chat.openaiChatCompletions': { kind: 'stream' as const, frames: result.events },
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/**
 * The OpenAI Chat Completions wire, as the chain that dials it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs this, whether the
 * client spoke OpenAI Chat Completions or a handoff arrived here — which is what makes a rule that
 * speaks about *this* wire belong here. The role rewrite states what an upstream's Chat
 * Completions endpoint accepts; the usage rules speak about the usage this wire asks for and
 * this wire reports; the vendor dialects are how one upstream spells both. All of them apply
 * to whatever body this wire actually sends and to nothing that leaves for another protocol.
 *
 * The order is the one the rules had as an onion, which is the same order in both directions:
 * a stage earlier in the array rewrites the request first and reads the answer last. So the
 * usage chunk is asked for above everything, and coming back the vendor dialects have the
 * first say — the generic rules above them then read a body already in OpenAI-canonical form,
 * with the cache-bucket fold seeing cache fields under OpenAI's names and the carrier split
 * seeing usage the fold has already settled. The meter is above all of them, which is what
 * makes the figure it bills the one the client is shown.
 *
 * `disableReasoningOnForcedToolChoice` and `stripPromptCacheKey` are here rather than above
 * the fork, because both speak about what an upstream's OpenAI Chat Completions endpoint accepts —
 * so a turn that arrived over a translation gets them too. Both still precede every vendor
 * dialect on the request path: the canonical sentinel is emitted before a vendor spells it,
 * and the field an upstream would reject is gone before a vendor rewrites what is left.
 */
export const openaiChatCompletionsWire = (streamedUsage: string): readonly Stage[] => [
  meterChatWire({
    wire: 'openaiChatCompletions',
    answer: 'response.chat.openaiChatCompletions',
    streamedUsage,
    read: meterOpenAIChatCompletions,
  }),
  includeUsageStreamOptionsForOpenAIChatCompletions,
  normalizeUsageForOpenAIChatCompletions,
  disableReasoningOnForcedToolChoiceForOpenAIChatCompletions,
  applyRoleCompatibilityToOpenAIChatCompletions,
  stripPromptCacheKeyForOpenAIChatCompletions,
  normalizeExclusiveCachedTokensForOpenAIChatCompletions,
  vendorDeepSeekNormalizeForOpenAIChatCompletions,
  vendorQwenNormalizeForOpenAIChatCompletions,
  vendorKimiNormalizeForOpenAIChatCompletions,
  callOpenAIChatCompletionsUpstream,
];

/** This family's own reading, which every wire under it hands up. */
const STREAMED_USAGE = 'response.chat.openaiChatCompletions.streamedUsage';

/** The three wires `/v1/chat/completions` can be served on. Its own is the bare wire; each
 *  translated one is a handoff and then the target protocol's own wire. */
const openaiChatCompletionsWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'openaiChatCompletions':
    return compose('openaiChatCompletionsNative', openaiChatCompletionsWire(STREAMED_USAGE));
  case 'anthropicMessages':
    return compose('openaiChatCompletionsViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await translateOpenAIChatCompletionsViaAnthropicMessages(payload, {
          model: candidate.model.id,
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
          loadRemoteImage: createExternalImageLoader(use.gateway.abortSignal),
        }),
      }),
      ...anthropicMessagesWire(STREAMED_USAGE),
    ]);
  case 'openaiResponses':
    return compose('openaiChatCompletionsViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await translateOpenAIChatCompletionsViaOpenAIResponses(payload, { model: candidate.model.id }),
      }),
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  }
};

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Only a report carrying real counts
 *  replaces the running figure, so a trailing empty usage frame cannot wipe a good one. */
const meterOpenAIChatCompletions = (
  source: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>; readonly outcome: Deferred<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  // Declared as this run's own unfinished work, so the runner waits for it at teardown where
  // it can see it rather than the reading being started and forgotten.
  const outcome = defer(new Promise<StreamOutcome>(resolve => { settle = resolve; }));
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'openaiChatCompletions')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type === 'event') {
          const usage = billableUsageFromOpenAIChatCompletionsEvent(frame.event);
          if (usage !== null) reported = usage;
        }
        yield frame;
        // The terminator is written out before the read stops, because it is what the client
        // reads as the end. Stopping here also drops anything an upstream sends after it.
        if (isTerminal(frame)) { sawTerminal = true; return; }
      }
      // A stream that ran out without saying it ended is not a turn that finished. Serving
      // what arrived would present a truncated answer as a whole one.
      throw new Error(OPENAI_CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal chunk, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedEntity(reported, identity)], failed: !sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** The frame that says this turn is over: the transport's own terminator, or an error the
 *  upstream wrote into the stream instead of finishing it. */
const isTerminal = (frame: ProtocolFrame<OpenAIChatCompletionsStreamEvent>): boolean =>
  frame.type === 'done' || (frame.type === 'event' && openaiChatCompletionsErrorPayloadMessage(frame.event) !== null);

/** What one attempt is billable for. An upstream that reported nothing leaves no quantities
 *  at all, which is a different statement from reporting zero — and a rate can depend on the
 *  service tier and on how much input there was, so both travel as pricing facts rather than
 *  being folded into the quantities. */
const billedEntity = (usage: BillableUsage | undefined, identity: TelemetryModelIdentity): BillableEntity => {
  const tokens = tokenUsageFromBillableUsage(usage);
  if (tokens === null) return { identity, quantities: {} };
  const measurement = tokenUsageMeasurement(tokens);
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: OpenAIChatCompletionsPayload): ChatNarrowing<C<'response.chat.openaiChatCompletions' | 'response.chat.openaiChatCompletions.streamedUsage'>> => ({
  canServe: candidate => openaiChatCompletionsTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeOpenAIChatCompletionsAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /chat/completions endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.openaiChatCompletions.streamedUsage': null,
    'response.chat.openaiChatCompletions': {
      status,
      message,
      // What an OpenAI client reads: the condition's own type, and for a turn whose carried
      // state cannot be routed, the field at fault and the code that names it.
      envelope: {
        error: {
          message,
          type: 'invalid_request_error',
          ...(reason === 'routing-unavailable' ? { param: 'input', code: 'responses_item_routing_unavailable' } : {}),
        },
      },
    },
  }),
  refuses: ['response.chat.openaiChatCompletions', 'response.chat.openaiChatCompletions.streamedUsage'],
});

export type OpenAIChatCompletionsServeEntry = C<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol'
  | 'ingress.chat.openaiChatCompletions.wantsStream' | 'ingress.chat.openaiChatCompletions.wantsUsageChunk'
  | 'request.chat.openaiChatCompletions' | 'serve.model'
>;

export type OpenAIChatCompletionsServeExit = C<
  'response.chat.openaiChatCompletions.rendered' | 'response.chat.openaiChatCompletions.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const openaiChatCompletionsServePipeline = (payload: OpenAIChatCompletionsPayload): Pipeline<OpenAIChatCompletionsServeEntry, OpenAIChatCompletionsServeExit> =>
  compose('openaiChatCompletionsServe', [
    emitOpenAIChatCompletions,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.openaiChatCompletions'?: unknown })['response.chat.openaiChatCompletions']),
      handedUp => (handedUp as { 'response.chat.openaiChatCompletions.streamedUsage'?: unknown })['response.chat.openaiChatCompletions.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.openaiChatCompletions'?: unknown })['response.chat.openaiChatCompletions']),
      owns: [],
    }),
    materializeAttempt('request.chat.openaiChatCompletions'),
    dialChatWire({
      source: 'request.chat.openaiChatCompletions',
      needs: ['request.chat.openaiChatCompletions', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.openaiChatCompletions', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => openaiChatCompletionsTarget.pick(endpoints),
      wire: openaiChatCompletionsWireFor,
    }),
  ]);
