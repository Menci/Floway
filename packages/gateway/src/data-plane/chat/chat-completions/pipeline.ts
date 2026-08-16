// Chat Completions as a pipeline — the reference chain for the chat families.
//
//   emitChatCompletions        the edge: writes the answer in the shape the client asked for
//   writeSettlement            above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates      narrows to what can serve, in the order affinity asks for
//   failover                   runs what follows once per candidate
//   the interceptors           the shared array, each one a stage
//   callChatCompletionsUpstream  the ending: dials this candidate's wire
//
// The wire a candidate is dialled on is chosen per candidate rather than at assembly, and
// because failover re-runs the whole suffix the next candidate re-picks its own. Only the
// native wire is here; the translated ones hand up the same key, which is what will make
// them interchangeable with it.

import { analyzeChatCompletionsAffinity } from './affinity/ingress.ts';
import { billableUsageFromChatCompletionsEvent } from './usage.ts';
import type { UsageQuantities } from '../../../repo/types.ts';
import { tokenUsageQuantities } from '../../../repo/usage-metrics.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatFacts } from '../facts.ts';
import {
  applyRoleCompatibilityToChatCompletions,
  disableReasoningOnForcedToolChoiceForChatCompletions,
  stripPromptCacheKeyForChatCompletions,
} from '../interceptors.ts';
import { applyRulesToUpstreamChatCompletions } from '../shared/alias-rules.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import {
  chatCompletionsProtocolFrameToSSEFrame,
  collectChatCompletionsProtocolEventsToResult,
  type ChatCompletionsPayload,
  type ChatCompletionsStreamEvent,
} from '@floway-dev/protocols/chat-completions';
import { renderErrorEnvelope, type BillableUsage, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import { providerModelOf, type TelemetryModelIdentity } from '@floway-dev/provider';

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
  'response.chat.chatCompletions.streamedUsage': Promise<readonly BillableEntity[]> | null;
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
  C<'response.chat.chatCompletions.rendered' | 'response.http.status' | 'response.http.headers'>
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
  execute: async (facts, next) => {
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
        'response.chat.chatCompletions.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
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

    const frames = answer.frames as AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>;
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
 * The native wire. It dials Chat Completions and provides the answer at this family's own
 * response key — which is what will make it interchangeable with a translated chain: both
 * hand up `response.chat.chatCompletions`, and the stage above cannot tell which ran.
 */
const callChatCompletionsUpstream = defineStage<
  C<'request.chat.chatCompletions' | 'route.attempt' | 'ingress.http.headers'>,
  C<'response.chat.chatCompletions' | 'response.chat.chatCompletions.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callChatCompletionsUpstream',
  return: {
    provides: [
      'response.chat.chatCompletions',
      'response.chat.chatCompletions.streamedUsage',
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
    // as every stage between the fork and here has rewritten it. The id the client addressed
    // does not travel — the provider re-stamps whatever it resolved upstream — and an alias'
    // own rules apply to the body that is sent.
    const payload = { ...facts['request.chat.chatCompletions'], model: candidate.model.id };
    if (candidate.rules !== undefined) applyRulesToUpstreamChatCompletions(payload, candidate.rules);
    const { model: _addressed, ...body } = payload;

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
        'response.chat.chatCompletions.streamedUsage': null,
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
        'response.chat.chatCompletions.streamedUsage': null,
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state
    // must come back to.
    use.selectAffinity(candidate);
    const metered = meterChatCompletions(result.events, identity);
    return move({
      ...facts,
      'response.chat.chatCompletions': { kind: 'stream' as const, frames: metered.frames },
      'response.chat.chatCompletions.streamedUsage': metered.billable,
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Only a report carrying real counts
 *  replaces the running figure, so a trailing empty usage frame cannot wipe a good one. */
const meterChatCompletions = (
  source: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>,
  identity: TelemetryModelIdentity,
): { readonly frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>; readonly billable: Promise<readonly BillableEntity[]> } => {
  let settle!: (billable: readonly BillableEntity[]) => void;
  const billable = new Promise<readonly BillableEntity[]>(resolve => { settle = resolve; });
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        if (frame.type === 'event') {
          const usage = billableUsageFromChatCompletionsEvent(frame.event);
          if (usage !== null) reported = usage;
        }
        yield frame;
      }
    } finally {
      // Reached however the frames ended — the terminal chunk, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle([{ identity, quantities: billed(reported) }]);
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, billable };
};

/** An upstream that reported nothing leaves no quantities at all, which is a different
 *  statement from reporting zero. The two shapes are not interchangeable: what the upstream
 *  reported is per token category, and what is billed is per metric name. */
const billed = (usage: BillableUsage | undefined): UsageQuantities => {
  const tokens = tokenUsageFromBillableUsage(usage);
  return tokens === null ? {} : tokenUsageQuantities(tokens);
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: ChatCompletionsPayload): ChatNarrowing<C<'response.chat.chatCompletions'>> => ({
  source: 'chatCompletions',
  canServe: candidate => chatCompletionsTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeChatCompletionsAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /chat/completions endpoint.`,
  refuse: (status, message) => ({ 'response.chat.chatCompletions': { status, message } }),
  refuses: ['response.chat.chatCompletions'],
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
    applyRoleCompatibilityToChatCompletions,
    disableReasoningOnForcedToolChoiceForChatCompletions,
    stripPromptCacheKeyForChatCompletions,
    callChatCompletionsUpstream,
  ]);
