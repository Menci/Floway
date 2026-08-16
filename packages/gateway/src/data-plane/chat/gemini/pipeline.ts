// Gemini as a pipeline — the same chain as Chat Completions, for the one source-only family.
//
//   emitGemini                       the edge: writes the answer in the shape the client asked for
//   writeSettlement                  above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates            narrows to what can serve, in the order affinity asks for
//   failover                         runs what follows once per candidate
//   materializeAttempt               puts the payload this candidate is owed into the record
//   callGeminiViaChatCompletions     the ending: translates, dials, and meters what came back
//
// Gemini is source-only. Nothing translates *into* it, so it contributes one pipeline rather
// than two — a source role and no target role, and no other family's chain ever hands up
// `response.chat.gemini`.
//
// It is also the one family with no wire of its own: the provider surface has no `callGemini`,
// so every candidate is reached through a translation and the wire is whichever of the three
// translatable ones the picker finds on it. Only the first, Chat Completions, is built here.
//
// What is not built, stated rather than implied:
//   - the Messages and the Responses wires. Each is its own ending stage — a different
//     translate pair, a different provider method, and a different event dialect to meter on
//     — and until they exist a candidate that `canServe` admitted on one of those two is
//     dialled on Chat Completions anyway, which is the same interim state the Chat
//     Completions chain carries for its own two translated wires.
//   - `:countTokens`. It is a second entry against this protocol rather than another wire of
//     this one: no stream, no billable turn, and a `{ totalTokens }` envelope of its own.
//   - the Gemini interceptors and the affinity egress. The four `interceptors/` entries and
//     the thought-signature rewrite on the way out are still only in the interceptor form.
//   - the Google-RPC envelope `respond.ts` wrote into a client's own stream for a turn that
//     ended without a terminal event. The chain detects one — the ending stops reading at
//     the terminal frame and throws when the frames run out before one — but it leaves the
//     run as a throw rather than as that 502 envelope.
//
// One deliberate difference from `respond.ts`, shared with every other family on the
// pipeline: an upstream that refused is answered in its own words. A Chat Completions wire
// refuses in the OpenAI envelope, and that object is handed on as it came rather than being
// quoted back inside a Google-RPC `{ error: { code, message, status } }` — which also means
// the status the upstream sent is the status the client sees, with no coercion of the codes
// that envelope maps to `INTERNAL`.

import { analyzeGeminiAffinity } from './affinity/ingress.ts';
import { renderGeminiError } from './errors.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { billableUsageFromChatCompletionsEvent } from '../chat-completions/usage.ts';
import type { ChatFacts } from '../facts.ts';
import { applyRulesToUpstreamChatCompletions } from '../shared/alias-rules.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { renderProtocolError, type BillableUsage, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiProtocolEventsToResult,
  geminiProtocolFrameToSSEFrame,
  GEMINI_MISSING_TERMINAL_MESSAGE,
  isGeminiTerminalEvent,
  type GeminiPayload,
  type GeminiStreamEvent,
} from '@floway-dev/protocols/gemini';
import { providerModelOf, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateGeminiViaChatCompletions } from '@floway-dev/translate';

/** `:generateContent` has no wire of its own, so the whole preference list is translated:
 *  Chat Completions first, then Messages, then Responses. */
export const geminiTarget = chatTargetPicker(['chat-completions', 'messages', 'responses']);

/** What this family adds to the chat space. */
export interface GeminiFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.gemini.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.gemini.streamedUsage': Promise<StreamOutcome> | null;
}

type C<K extends keyof GeminiFacts> = { [P in K]: GeminiFacts[P] };

/**
 * The outermost edge. A Gemini answer is always a stream by the time it reaches here — the
 * wire below speaks SSE whatever the client asked for, and the translation back into Gemini
 * is itself a stream of frames — so what this decides is whether the client sees the frames
 * or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
const emitGemini = defineStage<
  C<'ingress.chat.gemini.wantsStream'>,
  C<'ingress.chat.gemini.wantsStream'>,
  C<'ingress.chat.gemini.wantsStream' | 'response.chat.gemini' | 'response.http.headers'>,
  C<'response.chat.gemini.rendered' | 'response.http.status' | 'response.http.headers'>
>({
  name: 'emitGemini',
  through: {
    request: {
      needs: ['ingress.chat.gemini.wantsStream'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.gemini', 'response.http.headers'],
      consumes: ['response.chat.gemini', 'response.http.headers'],
      provides: ['response.chat.gemini.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next) => {
    const back = await next(facts);
    const { 'response.chat.gemini': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.gemini.rendered': move(renderProtocolError(answer.body, () => renderGeminiError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.gemini.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>;
    if (!back['ingress.chat.gemini.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.gemini.rendered': move(
          await collectGeminiProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.gemini.rendered': move(renderSSE(frames)),
      'response.http.status': 200,
    };
  },
});

/** Gemini streams one JSON object per `data:` line and has no sentinel to write, which the
 *  protocol says by writing no frame at all for the one that ends the stream. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>): AsyncIterable<SseFrame> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = geminiProtocolFrameToSSEFrame(frame);
      if (written !== null) yield written;
    }
  })(),
});

/**
 * The Chat Completions wire. It translates the turn, dials, and hands the answer up at this
 * family's own response key — which is what makes it interchangeable with the two wires that
 * are not built yet: all three would provide `response.chat.gemini`, and the stage above
 * cannot tell which ran.
 *
 * The reading is taken on the dialect the upstream actually spoke. Usage is metered off the
 * Chat Completions frames on their way into the translation rather than off the Gemini frames
 * that come out of it, so a figure the upstream stated is billed as stated.
 */
const callGeminiViaChatCompletions = defineStage<
  C<'request.chat.gemini' | 'route.attempt' | 'ingress.http.headers'>,
  C<'response.chat.gemini' | 'response.chat.gemini.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callGeminiViaChatCompletions',
  return: {
    provides: [
      'response.chat.gemini',
      'response.chat.gemini.streamedUsage',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial — before the translation too, which can reject the
    // client's own input — so an attempt that never completes still names the candidate it was
    // made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    // The trip owns both directions: it builds the payload that goes out and hands back the
    // closure that turns the upstream's frames into Gemini's. What it translates is what the
    // record holds by now — the turn affinity materialized for this candidate, as every stage
    // between the fork and here has rewritten it, with client-carried state rewritten for the
    // upstream that will see it. The id the client addressed does not travel: Gemini carries
    // it in the URL, the trip stamps the candidate's own, and the wire is handed the body
    // without it. An alias' own rules apply to the translated body, which is the only shape
    // the wire will see.
    const trip = await translateGeminiViaChatCompletions(facts['request.chat.gemini'], { model: candidate.model.id });
    if (candidate.rules !== undefined) applyRulesToUpstreamChatCompletions(trip.target, candidate.rules);
    const { model: _addressed, ...body } = trip.target;

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
        'response.chat.gemini': { status: 502, message: error instanceof Error ? error.message : String(error) },
        'response.chat.gemini.streamedUsage': null,
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
        'response.chat.gemini': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        'response.chat.gemini.streamedUsage': null,
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state must
    // come back to.
    use.selectAffinity(candidate);
    // Where this turn ends is stated on the Gemini frames the client is handed, and what it
    // billed is read on the Chat Completions wire below them.
    const ending = { sawTerminal: false };
    const metered = meterChatCompletions(result.events, identity, use.gateway.attempt, ending);
    return move({
      ...facts,
      'response.chat.gemini': { kind: 'stream' as const, frames: geminiFramesUntilTerminal(trip.events(metered.frames), ending) },
      'response.chat.gemini.streamedUsage': metered.outcome,
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
  attempt: { firstOutputTokenAt: number | null },
  ending: { sawTerminal: boolean },
): { readonly frames: AsyncIterable<ProtocolFrame<ChatCompletionsStreamEvent>>; readonly outcome: Promise<StreamOutcome> } => {
  let settle!: (outcome: StreamOutcome) => void;
  const outcome = new Promise<StreamOutcome>(resolve => { settle = resolve; });
  // Running out without the terminal frame is what "it did not finish" means, and it is known
  // at the same moment the usage is.
  const sawTerminal = false;
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        // Time to first token is measured where the token is, which is the only place that
        // knows a frame carries generated content rather than the envelope around it — and
        // it is read on the dialect the upstream spoke, like the usage beside it.
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'chat-completions')) {
          attempt.firstOutputTokenAt = performance.now();
        }
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
      settle({ billable: [billedEntity(reported, identity)], failed: !ending.sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** Where a Gemini turn ends, stated on the frames the client is handed rather than on the
 *  wire below: a Chat Completions stream that closed cleanly without ever reporting a finish
 *  reason translates into candidates that never finish, and serving those would report a
 *  truncated answer as a whole one. */
const geminiFramesUntilTerminal = (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  ending: { sawTerminal: boolean },
): AsyncIterable<ProtocolFrame<GeminiStreamEvent>> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      yield frame;
      // The turn is over, so there is nothing further to read; returning here closes the
      // translation and the wire under it. The end is stated here and the usage is read on
      // the wire below, so one flag carries what the settlement needs from both.
      if (frame.type === 'done' || isGeminiTerminalEvent(frame.event)) {
        ending.sawTerminal = true;
        return;
      }
    }
    throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
  })(),
});

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
const narrowing = (payload: GeminiPayload): ChatNarrowing<C<'response.chat.gemini' | 'response.chat.gemini.streamedUsage'>> => ({
  canServe: candidate => geminiTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the Gemini generateContent endpoint.`,
  refuse: (status, message) => ({
    'response.chat.gemini': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.gemini.streamedUsage': null,
  }),
  refuses: ['response.chat.gemini', 'response.chat.gemini.streamedUsage'],
});

export type GeminiServeEntry = C<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.gemini.wantsStream'
  | 'request.chat.gemini' | 'serve.model'
>;

export type GeminiServeExit = C<
  'response.chat.gemini.rendered' | 'response.chat.gemini.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const geminiServePipeline = (payload: GeminiPayload): Pipeline<GeminiServeEntry, GeminiServeExit> =>
  compose('geminiServe', [
    emitGemini,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.gemini'?: unknown })['response.chat.gemini']),
      handedUp => (handedUp as { 'response.chat.gemini.streamedUsage'?: unknown })['response.chat.gemini.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.gemini'?: unknown })['response.chat.gemini']),
      owns: [],
    }),
    materializeAttempt('request.chat.gemini'),
    callGeminiViaChatCompletions,
  ]);
