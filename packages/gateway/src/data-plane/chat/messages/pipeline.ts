// Messages as a pipeline, on the chain Chat Completions established.
//
//   emitMessages           the edge: writes the answer in the shape the client asked for
//   writeSettlement        above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates  narrows to what can serve, in the order affinity asks for
//   failover               runs what follows once per candidate
//   materializeAttempt     puts the payload this candidate is owed into the record
//   dialChatWire           the ending: picks this candidate's wire and hands into it
//
// Three wires, all handing up `response.chat.messages`: this protocol's own, and the two
// translated ones — Messages via Responses and Messages via Chat Completions — each a
// handoff followed by that protocol's own wire. The stage above cannot tell which ran.
//
// `/v1/messages/count_tokens` is not one of them: it is a second operation over this
// protocol rather than another wire under this pipeline, so it is a chain of its own in
// `count-tokens.ts`. The web-search shim is not one of them either, and for a worse reason: it
// never became a stage and the interceptor array that ran it is gone, so a turn declaring
// Anthropic's native `web_search` reaches the upstream unshimmed and the flag that gates it does
// nothing. Only its request half survives on a live path, in the counting chain. The code is kept
// so that porting it starts from something rather than from nothing.

import { wrapMessagesAffinityEgress } from './affinity/egress.ts';
import { analyzeMessagesAffinity } from './affinity/ingress.ts';
import { renderMessagesError } from './errors.ts';
import { isClaudeCodeProbe, probeFrames } from './interceptors/answer-claude-code-probe.ts';
import { createMessagesBillableUsageReader } from './usage.ts';
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
import { chatCompletionsWire } from '../chat-completions/pipeline.ts';
import type { ChatFacts } from '../facts.ts';
import { dialChatWire, handOff, type ChatWire } from '../handoff.ts';
import {
  applyRoleCompatibilityToMessages,
  disableReasoningOnForcedToolChoiceForMessages,
  stripBillingAttributionFromMessages,
} from '../interceptors.ts';
import { responsesWire } from '../responses/pipeline.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { applyRulesToUpstreamMessages } from '../shared/alias-rules.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline, type Stage } from '@floway-dev/pipeline';
import { sseFrame, type BillableUsage, type ProtocolFrame, type SseFrame, type SseWritableFrame } from '@floway-dev/protocols/common';
import {
  collectMessagesProtocolEventsToResult,
  messagesProtocolFrameToSSEFrame,
  MESSAGES_MISSING_TERMINAL_MESSAGE,
  parseAnthropicBetaHeader,
  type MessagesPayload,
  type MessagesStreamEvent,
} from '@floway-dev/protocols/messages';
import { providerModelOf, type ChatTargetApi, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';

/** `/v1/messages` prefers its own wire, then the translated Responses path, then the
 *  translated Chat Completions path. */
export const messagesTarget = chatTargetPicker(['messages', 'responses', 'chat-completions']);

/** What this family adds to the chat space. */
export interface MessagesFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.messages.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.messages.streamedUsage': Promise<StreamOutcome> | null;
}

type M<K extends keyof MessagesFacts> = { [P in K]: MessagesFacts[P] };

/**
 * The outermost edge. A Messages answer is always a stream by the time it reaches here —
 * the upstream speaks SSE whatever the client asked for — so what this decides is whether
 * the client sees the frames or the one message they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead, by the protocol's own
 * reassembly. Neither shape can answer with half a message: the ending fails a stream that
 * ran out before `message_stop`, whichever of the two the client asked for.
 */
const emitMessages = defineStage<
  M<'ingress.chat.messages.wantsStream'>,
  M<'ingress.chat.messages.wantsStream'>,
  M<'ingress.chat.messages.wantsStream' | 'response.chat.messages' | 'response.http.headers'>,
  M<'response.chat.messages.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitMessages',
  through: {
    request: { needs: ['ingress.chat.messages.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.messages', 'response.http.headers'],
      consumes: ['response.chat.messages', 'response.http.headers'],
      provides: ['response.chat.messages.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.messages': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.messages.rendered': move(renderFailure(answer, () => renderMessagesError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.messages.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordFrames(
      wrapMessagesAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.messages.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.messages.rendered': move(
          await collectMessagesProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.messages.rendered': move(renderSSE(frames)),
      'response.http.status': 200,
    };
  },
});

/** Anthropic names its own SSE events, and every frame that has one is the client's. Which
 *  frames have an SSE form at all is the protocol's to say, and it says so by writing no
 *  frame — a stream terminator is a Chat Completions idea and there is nothing to send for
 *  it here. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>): AsyncIterable<SseFrame> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = messagesProtocolFrameToSSEFrame(frame);
      if (written !== null) yield written;
    }
  })(),
});

/**
 * The native wire. It dials Messages and provides the answer at this family's own response
 * key — which is what will make it interchangeable with a translated chain: both hand up
 * `response.chat.messages`, and the stage above cannot tell which ran.
 */
/**
 * Answers Claude Code's one-token probe itself, rather than spending an upstream turn on it.
 *
 * The CLI asks "is this model usable?" by generating one token against it and reporting the
 * model unusable if the call throws. A one-token cap is not portable — OpenAI's Responses API
 * floors `max_output_tokens` at 16 and rejects anything lower with a hard 400 — so every
 * Messages-via-Responses candidate fails a probe that is asking nothing this gateway cannot
 * answer. Resolution has already picked a real candidate by the time this runs, so an id no
 * upstream serves still fails above with a 404; what is suppressed is only the generation.
 *
 * It answers rather than descending, which is why it carries the `return` trait — and why it
 * has to live here rather than beside the shared interceptors: what it answers with is this
 * family's own response keys.
 */
const answerClaudeCodeProbe = defineStage<
  M<'request.chat.messages' | 'route.attempt' | 'ingress.http.headers'>,
  M<'request.chat.messages' | 'route.attempt' | 'ingress.http.headers'>,
  M<'response.chat.messages' | 'response.chat.messages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  M<'response.chat.messages' | 'response.chat.messages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  M<'response.chat.messages' | 'response.chat.messages.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'answerClaudeCodeProbe',
  through: {
    request: {
      needs: ['request.chat.messages', 'route.attempt', 'ingress.http.headers'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.messages', 'response.http.headers'],
      consumes: [],
      provides: [],
    },
  },
  return: {
    provides: [
      'response.chat.messages',
      'response.chat.messages.streamedUsage',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, next, use) => {
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    if (!isClaudeCodeProbe(facts['request.chat.messages'], headers)) return await next(facts);

    const candidate = use.resolveAttempt(facts['route.attempt']);
    // The probe is answered *for* this candidate, so it is the one a follow-up turn carrying
    // our own state must come back to — the same statement a dialled attempt makes.
    use.selectAffinity(candidate);
    use.log.debug('answering a Claude Code probe without dialling', { upstream: facts['route.attempt'].upstreamId });
    return move({
      ...facts,
      'response.chat.messages': {
        kind: 'stream' as const,
        frames: probeFrames(facts['request.chat.messages'].model),
      },
      // Nothing streams from an upstream here, so there is nothing still to read: the row is
      // written now, at zero, which keeps the request visible without inventing latency.
      'response.chat.messages.streamedUsage': null,
      'response.usage.billable': [{
        identity: telemetryModelIdentity(candidate, providerModelOf(candidate).id),
        quantities: {},
      }],
      'response.http.headers': [],
    });
  },
});

const callMessagesUpstream = (streamedUsage: string) => defineStage<
  M<'request.chat.messages' | 'route.attempt' | 'ingress.http.headers' | 'ingress.chat.sourceProtocol'>,
  M<'response.chat.messages' | 'response.usage.billable' | 'response.http.headers'> & Record<string, unknown>,
  ChatServices
>({
  name: 'callMessagesUpstream',
  return: {
    provides: [
      'response.chat.messages',
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

    // What the record holds by now: the payload affinity materialized for this candidate, as
    // every stage between the fork and here has rewritten it — or, on a translated wire, what
    // the handoff put here. A thinking signature was rewritten for the upstream that will see
    // it, and one that no upstream but the issuer can read was dropped rather than sent on.
    const body = bodyForAttempt(facts['request.chat.messages'], candidate, applyRulesToUpstreamMessages);

    // The client's own headers reach the upstream from the record, not from a live request
    // object: what a provider is allowed to forward is filtered per provider, and the dump
    // shows what was there to filter. Anthropic's beta flags are the exception — they have a
    // typed path of their own so no header allowlist can admit them, and they are the
    // client's own only when the client spoke this protocol: a turn that arrived here through
    // a translation asked for nothing on this wire, so the field is read off and then dropped
    // whichever protocol sent it.
    const headers = new Headers(facts['ingress.http.headers'].map(([name, value]): [string, string] => [name, value]));
    const anthropicBeta = facts['ingress.chat.sourceProtocol'] === 'messages'
      ? parseAnthropicBetaHeader(headers.get('anthropic-beta'))
      : [];
    headers.delete('anthropic-beta');

    let result;
    try {
      result = await candidate.provider.instance.callMessages(
        providerModelOf(candidate),
        body,
        use.gateway.abortSignal,
        { ...buildUpstreamCallOptions(candidate, use.gateway, headers), anthropicBeta },
      );
    } catch (error) {
      use.log.warn('dial failed', { upstream: facts['route.attempt'].upstreamId, error: String(error) });
      // A dial that never completed reached no upstream, so nothing was billed and there are
      // no headers to carry. What it leaves behind is the performance row settlement writes.
      return move({
        ...facts,
        'response.chat.messages': { status: 502, message: error instanceof Error ? error.message : String(error) },
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
        'response.chat.messages': {
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
    const metered = meterMessages(result.events, identity, use.gateway.attempt);
    return move({
      ...facts,
      'response.chat.messages': { kind: 'stream' as const, frames: metered.frames },
      [streamedUsage]: metered.outcome,
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/**
 * The Messages wire, as the chain that dials it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs this, whether the
 * client spoke Messages or a handoff arrived here — which is what makes a rule that speaks
 * about *this* wire belong here. The system-role rewrite states what an upstream's Messages
 * endpoint accepts, so it applies to whatever body this wire actually sends and to nothing
 * that leaves for another protocol.
 */
export const messagesWire = (streamedUsage: string): readonly Stage[] => [
  stripBillingAttributionFromMessages,
  disableReasoningOnForcedToolChoiceForMessages,
  applyRoleCompatibilityToMessages,
  callMessagesUpstream(streamedUsage),
];

/** This family's own reading, which every wire under it hands up. */
const STREAMED_USAGE = 'response.chat.messages.streamedUsage';

/** The three wires `/v1/messages` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
const messagesWireFor = (target: ChatTargetApi, candidate: ModelCandidate): ChatWire => {
  switch (target) {
  case 'messages':
    return compose('messagesNative', messagesWire(STREAMED_USAGE));
  case 'responses':
    return compose('messagesViaResponses', [
      handOff({
        from: { request: 'request.chat.messages', response: 'response.chat.messages' },
        to: { request: 'request.chat.responses', response: 'response.chat.responses' },
        trip: async payload => await translateMessagesViaResponses(payload, { model: candidate.model.id }),
      }),
      ...responsesWire(STREAMED_USAGE),
    ]);
  case 'chat-completions':
    return compose('messagesViaChatCompletions', [
      handOff({
        from: { request: 'request.chat.messages', response: 'response.chat.messages' },
        to: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
        trip: async payload => await translateMessagesViaChatCompletions(payload, { model: candidate.model.id }),
      }),
      ...chatCompletionsWire(STREAMED_USAGE),
    ]);
  }
};

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Anthropic states input accounting on
 *  `message_start` and output accounting on `message_delta`, so the reader that merges the
 *  two is per-stream state and is made here rather than shared. */
const meterMessages = (
  source: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>; readonly outcome: Promise<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>(resolve => { settle = resolve; });
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  let sawTerminal = false;
  const readBillableUsage = createMessagesBillableUsageReader();
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'messages')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type === 'event') {
          const usage = readBillableUsage(frame.event);
          if (usage !== null) reported = usage;
        }
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past `message_stop` would otherwise hold the client's stream open
        // with it; returning here closes the read, which cancels the upstream.
        if (isMessagesTerminalFrame(frame)) { sawTerminal = true; return; }
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // message was never stopped and never failed.
      throw new Error(MESSAGES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedEntity(reported, identity)], failed: !sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** What ends a Messages turn. Anthropic's own stream terminator is an event rather than a
 *  transport sentinel, and a stream that failed mid-turn says so with `error` in place of the
 *  `message_stop` that will now never come. */
const isMessagesTerminalFrame = (frame: ProtocolFrame<MessagesStreamEvent>): boolean =>
  frame.type === 'event' && (frame.event.type === 'message_stop' || frame.event.type === 'error');

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
const narrowing = (payload: MessagesPayload): ChatNarrowing<M<'response.chat.messages' | 'response.chat.messages.streamedUsage'>> => ({
  canServe: candidate => messagesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeMessagesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /messages endpoint.`,
  refuse: (status, message) => ({
    'response.chat.messages': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.messages.streamedUsage': null,
  }),
  refuses: ['response.chat.messages', 'response.chat.messages.streamedUsage'],
});

/** What this protocol writes on an idle connection. Anthropic defines a `ping` event and
 *  clients read it, so an SSE comment — invisible by design — is not the same wire byte.
 *  The route that serves this chain hands it to the seam alongside the frames. */
export const messagesKeepAlive: SseWritableFrame = sseFrame(JSON.stringify({ type: 'ping' }), 'ping');

export type MessagesServeEntry = M<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.messages.wantsStream'
  | 'request.chat.messages' | 'serve.model'
>;

export type MessagesServeExit = M<
  'response.chat.messages.rendered' | 'response.chat.messages.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const messagesServePipeline = (payload: MessagesPayload): Pipeline<MessagesServeEntry, MessagesServeExit> =>
  compose('messagesServe', [
    emitMessages,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.messages'?: unknown })['response.chat.messages']),
      handedUp => (handedUp as { 'response.chat.messages.streamedUsage'?: unknown })['response.chat.messages.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.messages'?: unknown })['response.chat.messages']),
      owns: [],
    }),
    materializeAttempt('request.chat.messages'),
    answerClaudeCodeProbe,
    dialChatWire({
      source: 'request.chat.messages',
      needs: ['request.chat.messages', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.messages', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => messagesTarget.pick(endpoints),
      wire: messagesWireFor,
    }),
  ]);
