// Chat Completions as a pipeline — the reference chain for the chat families.
//
//   emitChatCompletions        the edge: writes the answer in the shape the client asked for
//   writeSettlement            above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates      narrows to what can serve, in the order affinity asks for
//   failover                   runs what follows once per candidate
//   the interceptors           the shared array, each one a stage
//   dialChatWire               the ending: picks this candidate's wire and hands into it
//
// The wire a candidate is dialled on is chosen per candidate rather than at assembly, and
// because failover re-runs the whole suffix the next candidate re-picks its own. Its own
// wire is a bare ending; the two translated ones are a handoff and then that protocol's own
// wire, and all three hand up `response.chat.chatCompletions` — so the stage above cannot
// tell which ran.
//
// What sits *in* a wire rather than above the fork is the other half of the arrangement. A
// rule that speaks about an upstream's Chat Completions endpoint — the role rewrite does,
// which is why its interceptor form stood down on `ctx.targetApi !== 'chat-completions'` —
// belongs to the wire and not to the source chain, so a turn that leaves for another
// protocol never carries it. Said by position rather than by a guard: a stage below the fork
// runs only when this is the wire the fork chose.

import { wrapChatCompletionsAffinityEgress } from './affinity/egress.ts';
import { analyzeChatCompletionsAffinity } from './affinity/ingress.ts';
import { billableUsageFromChatCompletionsEvent } from './usage.ts';
import { recordFrames } from '../../../dump/turn-dump.ts';
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
import type { ChatFacts } from '../facts.ts';
import { dialChatWire, handOff, type ChatWire } from '../handoff.ts';
import {
  applyRoleCompatibilityToChatCompletions,
  disableReasoningOnForcedToolChoiceForChatCompletions,
  includeUsageStreamOptionsForChatCompletions,
  normalizeExclusiveCachedTokensForChatCompletions,
  normalizeUsageForChatCompletions,
  stripPromptCacheKeyForChatCompletions,
  vendorDeepSeekNormalizeForChatCompletions,
  vendorKimiNormalizeForChatCompletions,
  vendorQwenNormalizeForChatCompletions,
} from '../interceptors.ts';
import { messagesWire } from '../messages/pipeline.ts';
import { responsesWire } from '../responses/pipeline.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { applyRulesToUpstreamChatCompletions } from '../shared/alias-rules.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline, type Stage, type Use } from '@floway-dev/pipeline';
import {
  CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE,
  chatCompletionsErrorPayloadMessage,
  chatCompletionsProtocolFrameToSSEFrame,
  collectChatCompletionsProtocolEventsToResult,
  type ChatCompletionsPayload,
  type ChatCompletionsStreamEvent,
} from '@floway-dev/protocols/chat-completions';
import type { BillableUsage, ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import { providerModelOf, type ChatTargetApi, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateChatCompletionsViaMessages, translateChatCompletionsViaResponses } from '@floway-dev/translate';

/** `/v1/chat/completions` prefers its own wire, then the translated Messages path, then the
 *  translated Responses path. */
export const chatCompletionsTarget = chatTargetPicker(['chat-completions', 'messages', 'responses']);

/** What this family adds to the chat space. */
export interface ChatCompletionsFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.chatCompletions.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.chatCompletions.streamedUsage': Promise<StreamOutcome> | null;
}

type C<K extends keyof ChatCompletionsFacts> = { [P in K]: ChatCompletionsFacts[P] };

/**
 * The outermost edge. A chat answer is always a stream by the time it reaches here — the
 * upstream speaks SSE whatever the client asked for — so what this decides is whether the
 * client sees the frames or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
const emitChatCompletions = defineStage<
  C<'ingress.chat.chatCompletions.wantsStream' | 'ingress.chat.chatCompletions.wantsUsageChunk'>,
  C<'ingress.chat.chatCompletions.wantsStream' | 'ingress.chat.chatCompletions.wantsUsageChunk'>,
  C<'ingress.chat.chatCompletions.wantsStream' | 'ingress.chat.chatCompletions.wantsUsageChunk'
    | 'response.chat.chatCompletions' | 'response.http.headers'>,
  C<'response.chat.chatCompletions.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitChatCompletions',
  through: {
    request: {
      needs: ['ingress.chat.chatCompletions.wantsStream', 'ingress.chat.chatCompletions.wantsUsageChunk'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.chatCompletions', 'response.http.headers'],
      consumes: ['response.chat.chatCompletions', 'response.http.headers'],
      provides: ['response.chat.chatCompletions.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.chatCompletions': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.chatCompletions.rendered': move(renderFailure(
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
        'response.chat.chatCompletions.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordFrames(
      wrapChatCompletionsAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.chatCompletions.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.chatCompletions.rendered': move(
          await collectChatCompletionsProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.chatCompletions.rendered': move(renderSSE(frames, back['ingress.chat.chatCompletions.wantsUsageChunk'])),
      'response.http.status': 200,
    };
  },
});

/** Metering asks the upstream for a usage chunk on every streaming turn; whether the client
 *  is shown it is the client's own question. The protocol owns which frame that is, and says
 *  so by writing no frame at all. */
const renderSSE = (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  includeUsageChunk: boolean,
): AsyncIterable<SseFrame> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = chatCompletionsProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (written !== null) yield written;
    }
  })(),
});

/**
 * The wire. It dials Chat Completions and provides the answer at whichever family's response
 * key the chain above it reads — which is what makes it interchangeable with a translated
 * chain: both hand up `response.chat.chatCompletions`, and the stage above cannot tell which
 * ran.
 *
 * `streamedUsage` is the one key it is told. A wire hands up one reading whatever protocol it
 * spoke, and where that reading lands is the *source* family's own key rather than this
 * protocol's — so it is built with it rather than naming one of its own.
 */
const callChatCompletionsUpstream = (streamedUsage: string) => defineStage<
  C<'request.chat.chatCompletions' | 'route.attempt' | 'ingress.http.headers'>,
  C<'response.chat.chatCompletions' | 'response.usage.billable' | 'response.http.headers'> & Record<string, unknown>,
  ChatServices
>({
  name: 'callChatCompletionsUpstream',
  return: {
    provides: [
      'response.chat.chatCompletions',
      streamedUsage,
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
    const body = bodyForAttempt(facts['request.chat.chatCompletions'], candidate, applyRulesToUpstreamChatCompletions);

    let result;
    try {
      result = await candidate.provider.instance.callChatCompletions(
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
        'response.chat.chatCompletions': { status: 502, message: error instanceof Error ? error.message : String(error) },
        [streamedUsage]: null,
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
        'response.chat.chatCompletions': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        [streamedUsage]: null,
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state
    // must come back to.
    use.selectAffinity(candidate);
    const metered = meterChatCompletions(result.events, identity, use.gateway.attempt);
    return move({
      ...facts,
      'response.chat.chatCompletions': { kind: 'stream' as const, frames: metered.frames },
      [streamedUsage]: metered.outcome,
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/**
 * The Chat Completions wire, as the chain that dials it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs this, whether the
 * client spoke Chat Completions or a handoff arrived here — which is what makes a rule that
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
 * seeing usage the fold has already settled.
 *
 * `disableReasoningOnForcedToolChoice` and `stripPromptCacheKey` sit above the fork rather
 * than here, and both still precede every vendor dialect on the request path: the canonical
 * sentinel is emitted before a vendor spells it, and the field an upstream would reject is
 * gone before a vendor rewrites what is left.
 */
export const chatCompletionsWire = (streamedUsage: string): readonly Stage[] => [
  includeUsageStreamOptionsForChatCompletions,
  normalizeUsageForChatCompletions,
  applyRoleCompatibilityToChatCompletions,
  normalizeExclusiveCachedTokensForChatCompletions,
  vendorDeepSeekNormalizeForChatCompletions,
  vendorQwenNormalizeForChatCompletions,
  vendorKimiNormalizeForChatCompletions,
  callChatCompletionsUpstream(streamedUsage),
];

/** This family's own reading, which every wire under it hands up. */
const STREAMED_USAGE = 'response.chat.chatCompletions.streamedUsage';

/** The three wires `/v1/chat/completions` can be served on. Its own is the bare wire; each
 *  translated one is a handoff and then the target protocol's own wire. */
const chatCompletionsWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'chat-completions':
    return compose('chatCompletionsNative', chatCompletionsWire(STREAMED_USAGE));
  case 'messages':
    return compose('chatCompletionsViaMessages', [
      handOff({
        from: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
        to: { request: 'request.chat.messages', response: 'response.chat.messages' },
        trip: async payload => await translateChatCompletionsViaMessages(payload, {
          model: candidate.model.id,
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
          loadRemoteImage: createExternalImageLoader(use.gateway.abortSignal),
        }),
      }),
      ...messagesWire(STREAMED_USAGE),
    ]);
  case 'responses':
    return compose('chatCompletionsViaResponses', [
      handOff({
        from: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
        to: { request: 'request.chat.responses', response: 'response.chat.responses' },
        trip: async payload => await translateChatCompletionsViaResponses(payload, { model: candidate.model.id }),
      }),
      ...responsesWire(STREAMED_USAGE),
    ]);
  }
};

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Only a report carrying real counts
 *  replaces the running figure, so a trailing empty usage frame cannot wipe a good one. */
const meterChatCompletions = (
  source: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>; readonly outcome: Promise<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>(resolve => { settle = resolve; });
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'chat-completions')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type === 'event') {
          const usage = billableUsageFromChatCompletionsEvent(frame.event);
          if (usage !== null) reported = usage;
        }
        yield frame;
        // The terminator is written out before the read stops, because it is what the client
        // reads as the end. Stopping here also drops anything an upstream sends after it.
        if (isTerminal(frame)) { sawTerminal = true; return; }
      }
      // A stream that ran out without saying it ended is not a turn that finished. Serving
      // what arrived would present a truncated answer as a whole one.
      throw new Error(CHAT_COMPLETIONS_MISSING_TERMINAL_MESSAGE);
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
const isTerminal = (frame: ProtocolFrame<ChatCompletionsStreamEvent>): boolean =>
  frame.type === 'done' || (frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null);

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
const narrowing = (payload: ChatCompletionsPayload): ChatNarrowing<C<'response.chat.chatCompletions' | 'response.chat.chatCompletions.streamedUsage'>> => ({
  canServe: candidate => chatCompletionsTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeChatCompletionsAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /chat/completions endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.chatCompletions.streamedUsage': null,
    'response.chat.chatCompletions': {
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
  refuses: ['response.chat.chatCompletions', 'response.chat.chatCompletions.streamedUsage'],
});

export type ChatCompletionsServeEntry = C<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol'
  | 'ingress.chat.chatCompletions.wantsStream' | 'ingress.chat.chatCompletions.wantsUsageChunk'
  | 'request.chat.chatCompletions' | 'serve.model'
>;

export type ChatCompletionsServeExit = C<
  'response.chat.chatCompletions.rendered' | 'response.chat.chatCompletions.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const chatCompletionsServePipeline = (payload: ChatCompletionsPayload): Pipeline<ChatCompletionsServeEntry, ChatCompletionsServeExit> =>
  compose('chatCompletionsServe', [
    emitChatCompletions,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.chatCompletions'?: unknown })['response.chat.chatCompletions']),
      handedUp => (handedUp as { 'response.chat.chatCompletions.streamedUsage'?: unknown })['response.chat.chatCompletions.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.chatCompletions'?: unknown })['response.chat.chatCompletions']),
      owns: [],
    }),
    materializeAttempt('request.chat.chatCompletions'),
    disableReasoningOnForcedToolChoiceForChatCompletions,
    stripPromptCacheKeyForChatCompletions,
    dialChatWire({
      source: 'request.chat.chatCompletions',
      needs: ['request.chat.chatCompletions', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.chatCompletions', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => chatCompletionsTarget.pick(endpoints),
      wire: chatCompletionsWireFor,
    }),
  ]);
