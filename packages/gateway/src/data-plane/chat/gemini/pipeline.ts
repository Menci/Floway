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
// so every candidate is reached through a translation and all three wires are translated ones
// — a handoff into Chat Completions, into Messages or into Responses, followed by that
// protocol's own wire. Which one a candidate is dialled on is the picker's answer for that
// candidate, and failover re-running the suffix is what re-asks for the next.
//
// Because every wire is translated, the reading is taken on the dialect the upstream actually
// spoke: the target protocol's own wire meters its own frames on their way into the
// translation, so a figure the upstream stated is billed as stated. Where the *turn* ends is
// a different question and is stated on the Gemini frames the client is handed, which is what
// `requireGeminiTerminal` is for — a Chat Completions stream that closed cleanly without ever
// reporting a finish reason translates into candidates that never finish.
//
// `:countTokens` is not one of the three: it is a second operation over this protocol rather
// than another wire under this pipeline — no stream, no billable turn, and a
// `{ totalTokens }` envelope of its own — so it is a chain of its own in `count-tokens.ts`.
//
// What is not built, stated rather than implied:
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

import { wrapGeminiAffinityEgress } from './affinity/egress.ts';
import { analyzeGeminiAffinity } from './affinity/ingress.ts';
import { renderGeminiError } from './errors.ts';
import { recordFrames } from '../../../dump/turn-dump.ts';
import { isFailure, renderFailure } from '../../pipeline/facts.ts';
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
import { messagesWire } from '../messages/pipeline.ts';
import { responsesWire } from '../responses/pipeline.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, transform, type Pipeline } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiProtocolEventsToResult,
  geminiProtocolFrameToSSEFrame,
  GEMINI_MISSING_TERMINAL_MESSAGE,
  isGeminiTerminalEvent,
  type GeminiPayload,
  type GeminiStreamEvent,
} from '@floway-dev/protocols/gemini';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses } from '@floway-dev/translate';

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
        'response.chat.gemini.rendered': move(renderFailure(answer, () => renderGeminiError(answer.status, answer.message))),
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
    const frames = recordFrames(
      wrapGeminiAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
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

/** The three wires `:generateContent` can be served on, and all three are translated ones:
 *  the provider surface has no Gemini call, so a handoff is how every candidate is reached. */
const geminiWireFor = (target: ChatTargetApi, candidate: ModelCandidate): ChatWire => {
  const context = { model: candidate.model.id, fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens };
  switch (target) {
  case 'chat-completions':
    return compose('geminiViaChatCompletions', [
      handOff({
        from: { request: 'request.chat.gemini', response: 'response.chat.gemini' },
        to: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
        trip: async payload => await translateGeminiViaChatCompletions(payload, context),
      }),
      ...chatCompletionsWire(STREAMED_USAGE),
    ]);
  case 'messages':
    return compose('geminiViaMessages', [
      handOff({
        from: { request: 'request.chat.gemini', response: 'response.chat.gemini' },
        to: { request: 'request.chat.messages', response: 'response.chat.messages' },
        trip: async payload => await translateGeminiViaMessages(payload, context),
      }),
      ...messagesWire(STREAMED_USAGE),
    ]);
  case 'responses':
    return compose('geminiViaResponses', [
      handOff({
        from: { request: 'request.chat.gemini', response: 'response.chat.gemini' },
        to: { request: 'request.chat.responses', response: 'response.chat.responses' },
        trip: async payload => await translateGeminiViaResponses(payload, context),
      }),
      ...responsesWire(STREAMED_USAGE),
    ]);
  }
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
