// Gemini generateContent as a pipeline — the same chain as OpenAI Chat Completions, for the
// one source-only family.
//
//   emitGeminiGenerateContent  the edge: writes the answer in the shape the client asked for
//   writeSettlement            above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates      narrows to what can serve, in the order affinity asks for
//   failover                   runs what follows once per candidate
//   materializeAttempt         puts the payload this candidate is owed into the record
//   the strippers, then requireGeminiGenerateContentTerminal
//   dialChatWire               the ending: picks this candidate's wire and hands into it
//
// Gemini generateContent is source-only. Nothing translates *into* it, so it contributes one pipeline rather
// than two — a source role and no target role, and no other family's chain ever hands up
// `response.chat.geminiGenerateContent`.
//
// It is also the one family with no wire of its own: the provider surface has no `callGeminiGenerateContent`,
// so every candidate is reached through a translation and all three wires are translated ones
// — a handoff into OpenAI Chat Completions, into Anthropic Messages or into OpenAI Responses, followed by that
// protocol's own wire. Which one a candidate is dialled on is the picker's answer for that
// candidate, and failover re-running the suffix is what re-asks for the next.
//
// Because every wire is translated, the reading is taken on the dialect the upstream actually
// spoke: the target protocol's own wire meters its own frames on their way into the
// translation, so a figure the upstream stated is billed as stated. Where the *turn* ends is
// a different question and is stated on the Gemini generateContent frames the client is handed,
// which is what `requireGeminiGenerateContentTerminal` is for — an OpenAI Chat Completions stream that closed cleanly without ever
// reporting a finish reason translates into candidates that never finish.
//
// `:countTokens` is not one of the three: it is a second operation over this protocol rather
// than another wire under this pipeline — no stream, no billable turn, and a
// `{ totalTokens }` envelope of its own — so it is a chain of its own in `count-tokens.ts`.
//
// What is not built, stated rather than implied: the Google-RPC envelope the replaced surface
// wrote into a client's own stream for a turn that ended without a terminal event. The chain
// detects one and leaves the run as a throw rather than as that 502 envelope.
//
// A refusal is the one place where having no wire of its own changes what a client is owed.
// Every other family can hand an upstream's own error object on, because the upstream spoke
// that family's protocol. Here it never did: whatever came back was written by OpenAI Chat
// Completions, Anthropic Messages or OpenAI Responses, and `error.status` — the field a Google client reads —
// is in none of them. So the words survive and the shape is this protocol's, which is what
// the handoff arranges by dropping a foreign envelope on the way up.
//
// The status is still the upstream's, with no coercion of the codes a Google-RPC envelope
// maps to `INTERNAL`. That part is a departure from the replaced surface, which raised such a
// status to 500.

import { wrapGeminiGenerateContentAffinityEgress } from './affinity/egress.ts';
import { analyzeGeminiGenerateContentAffinity } from './affinity/ingress.ts';
import { renderGeminiGenerateContentError } from './errors.ts';
import { recordStream, streamReferenceOf } from '../../../dump/turn-dump.ts';
import { isFailure, renderFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { anthropicMessagesWire } from '../anthropic-messages/pipeline.ts';
import type { ChatFacts } from '../facts.ts';
import { dialChatWire, handOff, type ChatWire } from '../handoff.ts';
import { openaiChatCompletionsWire } from '../openai-chat-completions/pipeline.ts';
import { openaiResponsesWire } from '../openai-responses/pipeline.ts';
import {
  stripSafetySettingsFromGeminiGenerateContent,
  stripUnsupportedPartFieldsFromGeminiGenerateContent,
  stripUnsupportedToolsFromGeminiGenerateContent,
  suppressThoughtPartsFromGeminiGenerateContent,
} from '../rules.ts';
import { affinityEgressOptions } from '../shared/affinity/index.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, transform, type Deferred, type Pipeline } from '@floway-dev/pipeline';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import {
  collectGeminiGenerateContentProtocolEventsToResult,
  geminiGenerateContentProtocolFrameToSSEFrame,
  GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE,
  isGeminiGenerateContentTerminalEvent,
  type GeminiGenerateContentPayload,
  type GeminiGenerateContentStreamEvent,
} from '@floway-dev/protocols/gemini-generate-content';
import type { ChatTargetApi, ModelCandidate } from '@floway-dev/provider';
import { translateGeminiGenerateContentViaOpenAIChatCompletions, translateGeminiGenerateContentViaAnthropicMessages, translateGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

/** `:generateContent` has no wire of its own, so the whole preference list is translated:
 *  OpenAI Chat Completions first, then Anthropic Messages, then OpenAI Responses. */
export const geminiGenerateContentTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);

/** What this family adds to the chat space. */
export interface GeminiGenerateContentFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.geminiGenerateContent.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.geminiGenerateContent.streamedUsage': Deferred<StreamOutcome> | null;
}

type C<K extends keyof GeminiGenerateContentFacts> = { [P in K]: GeminiGenerateContentFacts[P] };

/**
 * The outermost edge. A Gemini generateContent answer is always a stream by the time it reaches
 * here — the wire below speaks SSE whatever the client asked for, and the translation back into Gemini generateContent
 * is itself a stream of frames — so what this decides is whether the client sees the frames
 * or the one object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead.
 */
const emitGeminiGenerateContent = defineStage<
  C<'ingress.chat.geminiGenerateContent.wantsStream'>,
  C<'ingress.chat.geminiGenerateContent.wantsStream'>,
  C<'ingress.chat.geminiGenerateContent.wantsStream' | 'response.chat.geminiGenerateContent' | 'response.http.headers'>,
  C<'response.chat.geminiGenerateContent.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitGeminiGenerateContent',
  through: {
    request: {
      needs: ['ingress.chat.geminiGenerateContent.wantsStream'],
      consumes: [],
      provides: [],
    },
    response: {
      needs: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      consumes: ['response.chat.geminiGenerateContent', 'response.http.headers'],
      provides: ['response.chat.geminiGenerateContent.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.geminiGenerateContent': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(renderFailure(answer, () => renderGeminiGenerateContentError(answer.status, answer.message))),
        'response.http.status': answer.status,
      };
    }
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // The turn's own state, written back into the frames the client is handed: a follow-up
    // carrying it comes back to the upstream that issued it. This is the other half of the
    // affinity the resolver read on the way down, and it has to sit here because it rewrites
    // the frames — below the fold, and there would be nothing left to rewrite.
    const frames = recordStream(
      wrapGeminiGenerateContentAffinityEgress(
        answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
        affinityEgressOptions(use.gateway),
      ),
      use.gateway.dump,
    );
    if (!back['ingress.chat.geminiGenerateContent.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.geminiGenerateContent.rendered': move(
          await collectGeminiGenerateContentProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.geminiGenerateContent.rendered': move(renderSSE(frames)),
      'response.http.status': 200,
    };
  },
});

/** Gemini generateContent streams one JSON object per `data:` line and has no sentinel to write, which the
 *  protocol says by writing no frame at all for the one that ends the stream. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      const written = geminiGenerateContentProtocolFrameToSSEFrame(frame);
      if (written !== null) yield written;
    }
  })(),
});

/**
 * Says where a Gemini generateContent turn ends, on the frames the client is handed rather than on the wire
 * below them.
 *
 * The two are not the same statement. An OpenAI Chat Completions stream that closed cleanly without
 * ever reporting a finish reason ends its own dialect properly and translates into candidates
 * that never finish, and serving those would report a truncated answer as a whole one. So the
 * turn's end is read here, where the protocol the client speaks is, and the wire's end is read
 * on the wire.
 *
 * It sits below the thought suppressor and above the fork: what it truncates is what the rules
 * above it then work on, which is the order the fused ending had.
 */
const requireGeminiGenerateContentTerminal = defineStage<
  Record<string, never>,
  Record<string, never>,
  C<'response.chat.geminiGenerateContent'>,
  C<'response.chat.geminiGenerateContent'>
>({
  name: 'requireGeminiGenerateContentTerminal',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: { needs: ['response.chat.geminiGenerateContent'], consumes: [], provides: ['response.chat.geminiGenerateContent'] },
  },
  execute: transform<
    Record<string, never>,
    Record<string, never>,
    C<'response.chat.geminiGenerateContent'>,
    C<'response.chat.geminiGenerateContent'>
  >(() => ({
    response: facts => {
      const answer = facts['response.chat.geminiGenerateContent'];
      // A refusal and a collected body never opened a stream, so there is no end to find.
      if (isFailure(answer) || answer.kind !== 'stream') return facts;
      const frames = answer.frames as AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>;
      return {
        ...facts,
        'response.chat.geminiGenerateContent': move({
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
  frames: AsyncIterable<ProtocolFrame<GeminiGenerateContentStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiGenerateContentStreamEvent>> {
  for await (const frame of frames) {
    yield frame;
    if (frame.type === 'done' || isGeminiGenerateContentTerminalEvent(frame.event)) return;
  }
  throw new Error(GEMINI_GENERATE_CONTENT_MISSING_TERMINAL_MESSAGE);
};

/** This family's own reading, which every wire under it hands up. */
const STREAMED_USAGE = 'response.chat.geminiGenerateContent.streamedUsage';

/** The three wires `:generateContent` can be served on, and all three are translated ones:
 *  the provider surface has no Gemini generateContent call, so a handoff is how every candidate is reached. */
const geminiGenerateContentWireFor = (target: ChatTargetApi, candidate: ModelCandidate): ChatWire => {
  const context = { model: candidate.model.id, fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens };
  switch (target) {
  case 'openaiChatCompletions':
    return compose('geminiGenerateContentViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await translateGeminiGenerateContentViaOpenAIChatCompletions(payload, context),
      }),
      ...openaiChatCompletionsWire(STREAMED_USAGE),
    ]);
  case 'anthropicMessages':
    return compose('geminiGenerateContentViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await translateGeminiGenerateContentViaAnthropicMessages(payload, context),
      }),
      ...anthropicMessagesWire(STREAMED_USAGE),
    ]);
  case 'openaiResponses':
    return compose('geminiGenerateContentViaOpenAIResponses', [
      handOff({
        from: { request: 'request.chat.geminiGenerateContent', response: 'response.chat.geminiGenerateContent' },
        to: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        trip: async payload => await translateGeminiGenerateContentViaOpenAIResponses(payload, context),
      }),
      ...openaiResponsesWire(STREAMED_USAGE),
    ]);
  }
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: GeminiGenerateContentPayload): ChatNarrowing<C<'response.chat.geminiGenerateContent' | 'response.chat.geminiGenerateContent.streamedUsage'>> => ({
  canServe: candidate => geminiGenerateContentTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeGeminiGenerateContentAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the Gemini generateContent endpoint.`,
  refuse: (status, message) => ({
    'response.chat.geminiGenerateContent': { status, message },
    // A refusal never opened a stream, so there is nothing still to read — which is what
    // lets settlement write its row here rather than wait for numbers that never come.
    'response.chat.geminiGenerateContent.streamedUsage': null,
  }),
  refuses: ['response.chat.geminiGenerateContent', 'response.chat.geminiGenerateContent.streamedUsage'],
});

export type GeminiGenerateContentServeEntry = C<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.geminiGenerateContent.wantsStream'
  | 'request.chat.geminiGenerateContent' | 'serve.model'
>;

export type GeminiGenerateContentServeExit = C<
  'response.chat.geminiGenerateContent.rendered' | 'response.chat.geminiGenerateContent.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const geminiGenerateContentServePipeline = (payload: GeminiGenerateContentPayload): Pipeline<GeminiGenerateContentServeEntry, GeminiGenerateContentServeExit> =>
  compose('geminiGenerateContentServe', [
    emitGeminiGenerateContent,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent']),
      handedUp => (handedUp as { 'response.chat.geminiGenerateContent.streamedUsage'?: unknown })['response.chat.geminiGenerateContent.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.geminiGenerateContent'?: unknown })['response.chat.geminiGenerateContent']),
      owns: [],
    }),
    materializeAttempt('request.chat.geminiGenerateContent'),
    stripUnsupportedPartFieldsFromGeminiGenerateContent,
    stripUnsupportedToolsFromGeminiGenerateContent,
    stripSafetySettingsFromGeminiGenerateContent,
    suppressThoughtPartsFromGeminiGenerateContent,
    requireGeminiGenerateContentTerminal,
    dialChatWire({
      source: 'request.chat.geminiGenerateContent',
      needs: ['request.chat.geminiGenerateContent', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.geminiGenerateContent', STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => geminiGenerateContentTarget.pick(endpoints),
      wire: geminiGenerateContentWireFor,
    }),
  ]);
