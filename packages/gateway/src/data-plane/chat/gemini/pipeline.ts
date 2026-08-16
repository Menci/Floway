// Gemini as a pipeline — the same chain as Chat Completions, for the one source-only family.
//
//   emitGemini                       the edge: writes the answer in the shape the client asked for
//   writeSettlement                  above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates            narrows to what can serve, in the order affinity asks for
//   failover                         runs what follows once per candidate
//   materializeAttempt               puts the payload this candidate is owed into the record
//   the strippers, then requireGeminiTerminal
//   dialChatWire                     the ending: picks this candidate's wire and hands into it
//
// Gemini is source-only. Nothing translates *into* it, so it contributes one pipeline rather
// than two — a source role and no target role, and no other family's chain ever hands up
// `response.chat.gemini`.
//
// It is also the one family with no wire of its own: the provider surface has no `callGemini`,
// so every candidate is reached through a translation and the wire is whichever of the three
// translatable ones the picker finds on it. Only the first, Chat Completions, is built here —
// a handoff into that protocol, followed by that protocol's own wire.
//
// Because every wire is translated, the reading is taken on the dialect the upstream actually
// spoke: the target protocol's own wire meters its own frames on their way into the
// translation, so a figure the upstream stated is billed as stated. Where the *turn* ends is
// a different question and is stated on the Gemini frames the client is handed, which is what
// `requireGeminiTerminal` is for — a Chat Completions stream that closed cleanly without ever
// reporting a finish reason translates into candidates that never finish.
//
// What is not built, stated rather than implied:
//   - the Messages and the Responses wires. Each is a handoff of its own into that protocol's
//     wire, and until they exist a candidate the picker admitted on one of those two is
//     dialled on Chat Completions anyway, which is the same interim state the other three
//     chains carry for their own translated wires.
//   - `:countTokens`. It is a second entry against this protocol rather than another wire of
//     this one: no stream, no billable turn, and a `{ totalTokens }` envelope of its own.
//   - the affinity egress' thought-signature rewrite is here, but the Gemini interceptors are
//     only partly stages: the four `interceptors/` entries are, and nothing else is.
//   - the Google-RPC envelope `respond.ts` wrote into a client's own stream for a turn that
//     ended without a terminal event. The chain detects one and leaves the run as a throw
//     rather than as that 502 envelope.
//
// One deliberate difference from `respond.ts`, shared with every other family on the
// pipeline: an upstream that refused is answered in its own words. A Chat Completions wire
// refuses in the OpenAI envelope, and that object is handed on as it came rather than being
// quoted back inside a Google-RPC `{ error: { code, message, status } }` — which also means
// the status the upstream sent is the status the client sees, with no coercion of the codes
// that envelope maps to `INTERNAL`.

import { analyzeGeminiAffinity } from './affinity/ingress.ts';
import { renderGeminiError } from './errors.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { chatCompletionsWire } from '../chat-completions/pipeline.ts';
import type { ChatFacts } from '../facts.ts';
import { dialChatWire, handOff, type ChatWire } from '../handoff.ts';
import {
  stripSafetySettingsFromGemini,
  stripUnsupportedPartFieldsFromGemini,
  stripUnsupportedToolsFromGemini,
  suppressThoughtPartsFromGemini,
} from '../interceptors.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { wrapGeminiAffinityEgress } from './affinity/egress.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, transform, type Pipeline } from '@floway-dev/pipeline';
import { renderProtocolError, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiProtocolEventsToResult,
  geminiProtocolFrameToSSEFrame,
  GEMINI_MISSING_TERMINAL_MESSAGE,
  isGeminiTerminalEvent,
  type GeminiPayload,
  type GeminiStreamEvent,
} from '@floway-dev/protocols/gemini';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
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
  C<'response.chat.gemini.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
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
  execute: async (facts, next, use) => {
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

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = wrapGeminiAffinityEgress(
      answer.frames as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
      affinityEgressOptions(use.gateway),
    );
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
 * Says where a Gemini turn ends, on the frames the client is handed rather than on the wire
 * below them.
 *
 * The two are not the same statement. A Chat Completions stream that closed cleanly without
 * ever reporting a finish reason ends its own dialect properly and translates into candidates
 * that never finish, and serving those would report a truncated answer as a whole one. So the
 * turn's end is read here, where the protocol the client speaks is, and the wire's end is read
 * on the wire.
 *
 * It sits below the thought suppressor and above the fork: what it truncates is what the rules
 * above it then work on, which is the order the fused ending had.
 */
const requireGeminiTerminal = defineStage<
  Record<string, never>,
  Record<string, never>,
  C<'response.chat.gemini'>,
  C<'response.chat.gemini'>
>({
  name: 'requireGeminiTerminal',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.chat.gemini'], consumes: [], provides: ['response.chat.gemini'] },
  },
  execute: transform<
    Record<string, never>,
    Record<string, never>,
    C<'response.chat.gemini'>,
    C<'response.chat.gemini'>
  >(() => ({
    response: facts => {
      const answer = facts['response.chat.gemini'];
      // A refusal and a collected body never opened a stream, so there is no end to find.
      if (isFailure(answer) || answer.kind !== 'stream') return facts;
      const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>;
      return {
        ...facts,
        'response.chat.gemini': move({
          kind: 'stream' as const,
          frames: { [Symbol.asyncIterator]: () => framesUntilTerminal(frames) },
        }),
      };
    },
  })),
});

/** Stops at the frame that ends the turn — there is nothing further to read, and returning
 *  here closes the translation and the wire under it — and fails a stream that ran out before
 *  one arrived. */
const framesUntilTerminal = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  for await (const frame of frames) {
    yield frame;
    if (frame.type === 'done' || isGeminiTerminalEvent(frame.event)) return;
  }
  throw new Error(GEMINI_MISSING_TERMINAL_MESSAGE);
};

/** This family's own reading, which every wire under it hands up. */
const STREAMED_USAGE = 'response.chat.gemini.streamedUsage';

/** The wires `:generateContent` can be served on, and every one of them is a translated one:
 *  the provider surface has no Gemini call, so a handoff is how every candidate is reached.
 *  Only the first preference is built; until the other two exist a candidate the picker
 *  admitted on one of them is dialled here anyway. */
const geminiWireFor = (_target: ChatTargetApi, candidate: ModelCandidate): ChatWire =>
  compose('geminiViaChatCompletions', [
    handOff({
      from: { request: 'request.chat.gemini', response: 'response.chat.gemini' },
      to: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
      trip: async payload => await translateGeminiViaChatCompletions(payload, { model: candidate.model.id }),
    }),
    ...chatCompletionsWire(STREAMED_USAGE),
  ]);

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
    stripUnsupportedPartFieldsFromGemini,
    stripUnsupportedToolsFromGemini,
    stripSafetySettingsFromGemini,
    suppressThoughtPartsFromGemini,
    requireGeminiTerminal,
    dialChatWire({
      source: 'request.chat.gemini',
      needs: ['request.chat.gemini', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.gemini', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => geminiTarget.pick(endpoints),
      wire: geminiWireFor,
    }),
  ]);
