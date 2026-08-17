// Responses as a pipeline, on the chain Chat Completions established.
//
//   emitResponses          the edge: writes the answer in the shape the client asked for
//   writeSettlement        above the fork, so a run bills once however many wires it tried
//   hydrateStoredItems     the stored-items membrane, on the way in
//   resolveChatCandidates  narrows to what can serve, in the order affinity asks for
//   failover               runs what follows once per candidate
//   materializeAttempt     puts the payload this candidate is owed into the record
//   beginStoredAttempt     reseeds the store's per-attempt scratchpad
//   dialChatWire           the ending: picks this candidate's wire and hands into it
//
// Three wires, all handing up `response.chat.responses`: this protocol's own, and the two
// translated ones — Responses via Messages and Responses via Chat Completions — each a
// handoff followed by that protocol's own wire. What sits *in* a wire rather than above the
// fork is a rule that speaks about that wire: the role rewrite and the cache-bucket fold both
// do, which is why their interceptor forms stood down on `ctx.targetApi !== 'responses'`, and
// position says it here instead.
//
// Two transports enter here — `POST /v1/responses` and the WebSocket one — and the only thing
// they disagree about is how a streamed answer is framed, which is what `framing` says. Below
// the edge there is nothing to tell them apart: both open a run, both are outside the pipeline
// system, and neither needs a capability to start one.
//
// What this protocol owns and this chain does not is stated here rather than implied by its
// absence:
//
//   - `/v1/responses/compact`. A second operation over this protocol rather than another
//     wire under this pipeline, so it is a chain of its own in `compact.ts` — which reuses
//     this one's membrane, its narrowing and its wires, because a compaction routes and is
//     rewritten exactly as a turn is. The dial here asks for `generate`; what the ending
//     answers with is the branch the provider says it ran, which is why the envelope a
//     compaction is arrives somewhere rather than nowhere.
//   - this family's remaining interceptors, the server-tool shims among them. Still only in
//     the interceptor form, so the array between the materialized payload and the fork is
//     short rather than complete — and nothing in a pipelined turn writes to the store's
//     private-payload scratchpad, because the shim that writes to it is what is missing.
//
// One deliberate difference from `respond.ts`, shared with every other family on the
// pipeline: an upstream that refused is answered in its own words, with the status it sent,
// rather than being quoted back inside an envelope this gateway wrote.

import { analyzeResponsesAffinity } from './affinity/ingress.ts';
import { wrapResponsesClientEgress } from './client-output.ts';
import type { ResponsesServeFailure } from './errors.ts';
import { hydrateResponsesPayload } from './items/hydrate.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from './serve-prep.ts';
import { billableUsageFromResponsesEvent, billableUsageFromResponsesResult } from './usage.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
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
  applyRoleCompatibilityToResponses,
  disableReasoningOnForcedToolChoiceForResponses,
  normalizeExclusiveCachedTokensForResponses,
  stripPromptCacheKeyForResponses,
  vendorDeepSeekNormalizeForResponses,
  vendorQwenNormalizeForResponses,
} from '../interceptors.ts';
import { messagesWire } from '../messages/pipeline.ts';
import { applyRulesToUpstreamResponses } from '../shared/alias-rules.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline, type Stage, type Use } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, renderProtocolError, sseFrame, type BillableUsage, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  collectResponsesProtocolEventsToResult,
  isResponsesTerminalEvent,
  responsesProtocolFrameToSSEFrame,
  RESPONSES_MISSING_TERMINAL_MESSAGE,
  type CanonicalResponsesPayload,
  type ClientResponseResource,
  type ClientResponsesStreamEvent,
  type ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';
import { providerModelOf, toInternalDebugError, type ChatTargetApi, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';

/** `/v1/responses` prefers its own wire, then the translated Messages path, then the
 *  translated Chat Completions path. */
export const responsesTarget = chatTargetPicker(['responses', 'messages', 'chat-completions']);

/** How the transport that opened the run frames a streamed answer. Both carry this
 *  protocol's own events and neither adds or drops one: SSE is the format an HTTP body is
 *  written in, terminator and all, and a WebSocket turn writes each event as a text frame of
 *  its own — so the transport that owns the socket takes the events and frames them itself. */
export type ResponsesStreamFraming = 'sse' | 'events';

/** What this family adds to the chat space. */
export interface ResponsesFacts extends ChatFacts {
  /** Server-only state the gateway once attached to an item it emitted, keyed by that
   *  item's id, as the rows this turn hydrated carry it. It never reaches an upstream: it is
   *  what lets an item this turn re-emits be stored with the state it already had.
   *
   *  Pairs rather than a `Map`, for the same reason the header keys are: a `Map` has no own
   *  properties, so it would be written into the dump as an empty object and the record would
   *  say the turn hydrated nothing. */
  'request.chat.responses.privatePayloads': readonly (readonly [string, unknown])[];
  /** What the client is actually sent — an object when it asked for one, and the stream it
   *  asked to be streamed, in the framing its transport writes. The edge provides it, so a
   *  dump shows what the client received. */
  'response.chat.responses.rendered': Record<string, unknown> | AsyncIterable<SseFrame> | AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.responses.streamedUsage': Promise<StreamOutcome> | null;
}

type R<K extends keyof ResponsesFacts> = { [P in K]: ResponsesFacts[P] };

/**
 * The outermost edge. What reaches it is usually a stream — the upstream speaks SSE whatever
 * the client asked for — so what this decides is whether the client sees the frames or the
 * one response object they add up to.
 *
 * Collecting is therefore the edge's own work and not a second reading of the upstream: the
 * same frames that would have gone out are folded here instead, by the protocol's own
 * reassembly, which is what makes a stream that stopped short of its terminal event say so
 * rather than answer with half a response.
 *
 * The stored-items membrane's other half runs here too, and it takes the client's own
 * payload rather than the record's, because by the fork the record holds the prepared one —
 * `previous_response_id` expanded away — and the resource echoes what the client asked with.
 *
 * A streamed answer is handed on in the framing the transport that opened the run writes.
 * Only the last step differs: `renderSSE` is a wire format written over an HTTP body, and a
 * transport that frames each event itself takes the events it would have been written from.
 */
const emitResponses = (client: CanonicalResponsesPayload, framing: ResponsesStreamFraming) => defineStage<
  R<'ingress.chat.responses.wantsStream'>,
  R<'ingress.chat.responses.wantsStream'>,
  R<'ingress.chat.responses.wantsStream' | 'response.chat.responses' | 'response.http.headers'>,
  R<'response.chat.responses.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitResponses',
  through: {
    request: { needs: ['ingress.chat.responses.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.responses', 'response.http.headers'],
      consumes: ['response.chat.responses', 'response.http.headers'],
      provides: ['response.chat.responses.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.responses': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.responses.rendered': move(renderProtocolError(
          answer.body,
          () => answer.envelope ?? { error: { message: answer.message, type: 'api_error' } },
        )),
        'response.http.status': answer.status,
      };
    }
    // A turn the upstream answered with one body rather than a stream — the compaction
    // envelope — is already the object the client is owed, so there is nothing to fold.
    if (answer.kind === 'value') {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.responses.rendered': move(answer.body as Record<string, unknown>),
        'response.http.status': 200,
      };
    }

    // Everything this protocol writes back into its own frames, in one place because every
    // layer of it rewrites them and below the fold there would be nothing left to rewrite:
    // the terminal restated from the items that actually closed, the turn's own state sealed
    // into the carrier a follow-up comes back on, each complete item stored under its exact
    // id beneath one response id this gateway minted, and the resource completed to what the
    // schema requires of it. It runs before the fold rather than beside it, so a client that
    // did not ask to stream is answered with the object the persisted frames add up to.
    const frames = wrapResponsesClientEgress(
      answer.frames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
      use.gateway,
      client,
    );
    if (!back['ingress.chat.responses.wantsStream']) {
      try {
        return {
          ...rest,
          'response.http.headers': forClient,
          'response.chat.responses.rendered': move(
            await collectResponsesProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
          ),
          'response.http.status': 200,
        };
      } catch (error) {
        // Nothing has gone out yet, so the fault is still a status. A turn the gateway could
        // not finish — the snapshot the next turn would read, most often — is not one it can
        // answer, and the client is told what broke rather than handed the half that arrived.
        return {
          ...rest,
          'response.http.headers': forClient,
          'response.chat.responses.rendered': move(internalErrorEnvelope(error)),
          'response.http.status': 502,
        };
      }
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.responses.rendered': move(framing === 'sse' ? renderSSE(frames) : frames),
      'response.http.status': 200,
    };
  },
});

/** What a fault the gateway is answerable for looks like on this protocol, with the stack
 *  that says where it happened: this is the gateway's own failure and not an upstream's, so
 *  the body is a diagnostic rather than something a client is meant to parse. */
export const internalErrorEnvelope = (error: unknown): Record<string, unknown> => {
  const debug = toInternalDebugError(error);
  return {
    error: {
      type: debug.type,
      name: debug.name,
      message: debug.message,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  };
};

/** The spec nests the `error` event's payload under `error`, and both official SDKs key
 *  their mid-stream throw on exactly that key; the same fields at the top level are yielded
 *  to them as an ordinary event instead.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L170-L177
 *  https://github.com/openai/openai-node/blob/d77cf24d9f3885739c6cba76bc009abf0ab97428/src/core/streaming.ts#L69-L71
 *  https://github.com/openai/openai-python/blob/3844843c277f42b0b18beaa58152cfda61df524a/src/openai/_streaming.py#L87-L98 */
const streamErrorEvent = (error: unknown): ClientResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'error',
    error: {
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      target_api: debug.target_api,
    },
  } as unknown as ClientResponsesStreamEvent;
};

/** "Any error incurred while streaming will be followed by a `response.failed` event."
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430 */
const streamFailedEvent = (announced: ClientResponseResource, error: unknown): ClientResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'response.failed',
    response: { ...announced, status: 'failed', error: { code: debug.type, message: debug.message } },
  } as ClientResponsesStreamEvent;
};

/** Every Responses event has an SSE form of its own, so the render is a straight map. What
 *  it adds is the two endings a client already being streamed to can be given. The ordinary
 *  one is the terminator: the client's stream ends on the literal `[DONE]` payload whether or
 *  not the upstream's stream carried one, because that is what the transport reads to know
 *  the turn is over.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84
 *
 *  The other is a break — an upstream that died mid-stream, a turn that could not be stored,
 *  a stream that ran out before saying how it ended. The status went out with the headers, so
 *  the failure has to be said in the protocol's own words, and it is said *instead of* the
 *  terminator: a stream that ended on `[DONE]` is a stream that finished. */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<ClientResponsesStreamEvent>>): AsyncIterable<SseFrame> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    // The last resource the client was shown, which is the one a `response.failed` restates:
    // the id it names has to be the id the client already saw this turn under.
    let announced: ClientResponseResource | undefined;
    try {
      for await (const frame of frames) {
        // The upstream's own terminator is not the client's — the ending stops reading at the
        // turn's terminal event, and one terminator is written below however the frames ended.
        if (frame.type === 'done') continue;
        if ('response' in frame.event) announced = frame.event.response;
        yield responsesProtocolFrameToSSEFrame(frame);
      }
      yield responsesProtocolFrameToSSEFrame(doneFrame());
    } catch (error) {
      yield sseFrame(JSON.stringify(streamErrorEvent(error)), 'error');
      // Nothing was announced when the break came before the first resource-bearing event,
      // and there is no response to restate as failed.
      if (announced !== undefined) {
        yield responsesProtocolFrameToSSEFrame(eventFrame(streamFailedEvent(announced, error)));
      }
    }
  })(),
});

/**
 * The wire. It dials Responses and provides the answer at whichever family's response key the
 * chain above it reads — which is what makes it interchangeable with a translated chain: both
 * hand up `response.chat.responses`, and the stage above cannot tell which ran.
 */
const callResponsesUpstream = (streamedUsage: string) => defineStage<
  R<'request.chat.responses' | 'route.attempt' | 'ingress.http.headers'>,
  R<'response.chat.responses' | 'response.usage.billable' | 'response.http.headers'> & Record<string, unknown>,
  ChatServices
>({
  name: 'callResponsesUpstream',
  return: {
    provides: [
      'response.chat.responses',
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
    // the handoff put here. Client-carried state — an encrypted reasoning blob, a compaction
    // the upstream issued — was rewritten for the upstream that will see it, which is the
    // whole reason a turn can be pinned at all. The id the client addressed does not travel —
    // the provider re-stamps whatever it resolved upstream — and an alias' own rules apply to
    // the body that is sent.
    //
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to, which is the one a wire takes.
    const asked = facts['request.chat.responses'] as CanonicalResponsesPayload;
    const payload = { ...asked, model: candidate.model.id };
    if (candidate.rules !== undefined) applyRulesToUpstreamResponses(payload, candidate.rules);
    const { model: _addressed, ...body } = payload;

    let result;
    try {
      result = await candidate.provider.instance.callResponses(
        providerModelOf(candidate),
        body,
        'generate',
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
        'response.chat.responses': { status: 502, message: error instanceof Error ? error.message : String(error) },
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
        'response.chat.responses': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
        [streamedUsage]: null,
        'response.usage.billable': called,
        'response.http.headers': [...result.response.headers],
      });
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state must
    // come back to.
    use.selectAffinity(candidate);

    // A provider answers with the branch it actually ran, and one of them is not a stream:
    // a compaction is a single envelope that states its own counts, so there is nothing to
    // meter and nothing left to read. The fact space already carries a value beside a
    // stream at every protocol's response key, so that is where it rides.
    if (result.action === 'compact') {
      return move({
        ...facts,
        'response.chat.responses': { kind: 'value' as const, body: result.result },
        [streamedUsage]: null,
        'response.usage.billable': [billedResponsesEntity(identity, billableUsageFromResponsesResult(result.result) ?? undefined)],
        'response.http.headers': [],
      });
    }

    const metered = meterResponses(result.events, identity, use.gateway.attempt);
    return move({
      ...facts,
      'response.chat.responses': { kind: 'stream' as const, frames: metered.frames },
      [streamedUsage]: metered.outcome,
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/**
 * What an upstream's Responses endpoint accepts on an assistant item it produced itself.
 * Copilot's compaction translation and Azure-native compaction both emit assistant messages
 * whose content blocks carry `type: 'input_text'`, and both then refuse those same items
 * echoed back as input on the next turn. Every way prior upstream-produced history reaches a
 * wire arrives here — a direct client echo, the snapshot the membrane expanded, a compaction
 * tail — so this is the one place the canonical assistant content type is put back.
 *
 * Only this wire needs it. Both translators read `input_text` and `output_text` the same way
 * on assistant content, so a turn that leaves for Messages or Chat Completions never carried
 * the disagreement in the first place.
 */
const normalizeAssistantContentForResponses = defineStage<
  R<'request.chat.responses'>,
  R<'request.chat.responses'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'normalizeAssistantContentForResponses',
  through: {
    request: { needs: ['request.chat.responses'], consumes: [], provides: ['request.chat.responses'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.chat.responses'] as CanonicalResponsesPayload;
    const input = normalizeAssistantInputText(payload.input);
    // A rewrite that changed nothing hands the same payload on, so the record shows no
    // change where none happened.
    if (input === payload.input) return await next(facts);
    return await next({ ...facts, 'request.chat.responses': move({ ...payload, input }) });
  },
});

/**
 * What every turn this wire sends is subject to, whichever operation asked for it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs these, whether the
 * client spoke Responses or a handoff arrived here — which is what makes the three rules
 * belong to the wire. The role rewrite and the assistant-content rewrite both state what an
 * upstream's Responses endpoint accepts; the cache-bucket fold speaks about the usage *this*
 * wire reports and about the flag that describes it, and a translator emits the canonical
 * form, which is the one case the fold has nothing to do with.
 *
 * They are named apart from the dial because a compaction is dialled differently and is
 * subject to the same three.
 */
export const responsesWireRules: readonly Stage[] = [
  normalizeAssistantContentForResponses,
  applyRoleCompatibilityToResponses,
  normalizeExclusiveCachedTokensForResponses,
];

/** The Responses wire, as the chain that dials it. */
export const responsesWire = (streamedUsage: string): readonly Stage[] => [
  ...responsesWireRules,
  callResponsesUpstream(streamedUsage),
];

/** This family's own reading, which every wire under it hands up. */
export const RESPONSES_STREAMED_USAGE = 'response.chat.responses.streamedUsage';

/** The three wires `/v1/responses` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
export const responsesWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'responses':
    return compose('responsesNative', responsesWire(RESPONSES_STREAMED_USAGE));
  case 'messages':
    return compose('responsesViaMessages', [
      handOff({
        from: { request: 'request.chat.responses', response: 'response.chat.responses' },
        to: { request: 'request.chat.messages', response: 'response.chat.messages' },
        trip: async payload => await translateResponsesViaMessages(payload, {
          model: candidate.model.id,
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
          loadRemoteImage: createExternalImageLoader(use.gateway.abortSignal),
        }),
      }),
      ...messagesWire(RESPONSES_STREAMED_USAGE),
    ]);
  case 'chat-completions':
    return compose('responsesViaChatCompletions', [
      handOff({
        from: { request: 'request.chat.responses', response: 'response.chat.responses' },
        to: { request: 'request.chat.chatCompletions', response: 'response.chat.chatCompletions' },
        trip: async payload => await translateResponsesViaChatCompletions(payload, { model: candidate.model.id }),
      }),
      ...chatCompletionsWire(RESPONSES_STREAMED_USAGE),
    ]);
  }
};

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Responses states its counts on the
 *  lifecycle envelopes, and only one carrying real counts replaces the running figure, so an
 *  envelope that states none cannot wipe a good reading. */
const meterResponses = (
  source: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>; readonly outcome: Promise<StreamOutcome> } => {
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
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'responses')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const usage = billableUsageFromResponsesEvent(frame.event);
        if (usage !== null) reported = usage;
        // Read off the frame rather than off having been resumed past it. The stage that
        // stores the turn's items stops reading at the terminal event, so the resumption
        // never comes: what this loop would learn from it is already true when the frame
        // arrives, and the turn ended the way the upstream said it did whether or not
        // anything downstream asked for another.
        if (isResponsesTerminalEvent(frame.event)) sawTerminal = true;
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past its terminal event would otherwise hold the client's stream
        // open with it; returning here closes the read, which cancels the upstream.
        if (sawTerminal) return;
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // response was never stated complete, incomplete or failed.
      throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedResponsesEntity(identity, reported)], failed: !sawTerminal });
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, outcome };
};

/** An upstream that reported nothing leaves no quantities at all, which is a different
 *  statement from reporting zero.
 *
 *  A reading that did arrive is converted rather than cast: a billed entity is keyed by
 *  billing metric, which is not the shape a protocol reports in. The tier rides along
 *  because on this protocol it is not a quantity but a rate selector — `service_tier` states
 *  the tier the turn was actually served at, and that is the pricing entry it is billed
 *  under. */
export const billedResponsesEntity = (identity: TelemetryModelIdentity, usage: BillableUsage | undefined): BillableEntity => {
  if (usage === undefined) return { identity, quantities: {} };
  const measurement = tokenUsageMeasurement(tokenUsageFromBillableUsage(usage));
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant.
 *
 *  It reads the request through a function because the one it has to read is the *prepared*
 *  one: a `previous_response_id` continuation carries the prior turn's state on items the
 *  client never sent, and a turn is pinned by what its items carry. The narrowing is built
 *  at assembly, before any fact exists, so the membrane hands the prepared payload across
 *  through the run's own cell rather than through the record. */
export const responsesNarrowing = (prepared: () => CanonicalResponsesPayload): ChatNarrowing<R<'response.chat.responses' | 'response.chat.responses.streamedUsage'>> => ({
  canServe: candidate => responsesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeResponsesAffinity(prepared(), gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /responses endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.responses.streamedUsage': null,
    'response.chat.responses': {
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
  refuses: ['response.chat.responses', 'response.chat.responses.streamedUsage'],
});

/** A refusal the membrane makes on its own, in the shape every other refusal in this chain
 *  takes: an empty billed set and empty headers are what "no upstream was called" looks like
 *  on those two keys, and the envelope is what an OpenAI client reads. */
const refuseStoredItems = (
  status: number,
  message: string,
  extra: { readonly param: string; readonly code: string | null },
): R<'response.chat.responses' | 'response.chat.responses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'> => ({
  'response.usage.billable': [],
  'response.http.headers': [],
  'response.chat.responses.streamedUsage': null,
  'response.chat.responses': {
    status,
    message,
    envelope: { error: { message, type: 'invalid_request_error', ...extra } },
  },
});

/**
 * The stored-items membrane, on the way in.
 *
 * Three things, in an order the store fixes. A `previous_response_id` becomes the snapshot's
 * items in front of this turn's input, and the id itself never reaches a wire — it names
 * something only this gateway holds. Every item the turn now names is read back out of the
 * store, so an item the client echoed by id is sent as the row we stored rather than as the
 * client's copy of it, and whatever server-only state that row carried comes back with it.
 * Then the items this turn *adds* are staged, so the snapshot the next turn continues from
 * holds them alongside the history it inherited.
 *
 * It sits above the resolver because everything after it routes on the result: the payload
 * affinity reads is the hydrated one, and a turn whose continuation does not resolve has
 * nowhere to be routed to. Both of its refusals are answers it already holds, which is why
 * it carries the `return` trait alongside `through`.
 */
export const hydrateStoredItems = (
  client: CanonicalResponsesPayload,
  prepared: (payload: CanonicalResponsesPayload) => void,
) => defineStage<
  R<'request.chat.responses'>,
  R<'request.chat.responses' | 'request.chat.responses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  R<'response.chat.responses' | 'response.chat.responses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'hydrateStoredItems',
  through: {
    request: {
      needs: ['request.chat.responses'],
      consumes: [],
      provides: ['request.chat.responses', 'request.chat.responses.privatePayloads'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: {
    provides: [
      'response.chat.responses',
      'response.chat.responses.streamedUsage',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, next, use) => {
    const store = use.gateway.store;
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to.
    const asked = facts['request.chat.responses'] as CanonicalResponsesPayload;

    let expanded: CanonicalResponsesPayload;
    try {
      expanded = await expandPreviousResponseId(asked, store);
    } catch (error) {
      if (!(error instanceof PreviousResponseNotFoundError)) throw error;
      // OpenAI's own words for a continuation that does not resolve, byte for byte: Codex
      // compares this body against upstream's. See the cross-references on
      // `PreviousResponseNotFoundError`.
      return move({
        ...facts,
        ...refuseStoredItems(400, error.message, { param: 'previous_response_id', code: 'previous_response_not_found' }),
      });
    }

    // Both lists: what the turn now names is read by id, and what the client itself sent is
    // read by item hash as well, so a body repeated verbatim finds the row it already made.
    await store.loadInputItems(expanded.input, client.input);

    let hydrated: ReturnType<typeof hydrateResponsesPayload>;
    try {
      hydrated = hydrateResponsesPayload(expanded, store);
    } catch (error) {
      const failure = tryCatchChatServeFailure<ResponsesServeFailure>(error);
      if (failure?.kind !== 'item-not-found') throw error;
      return move({
        ...facts,
        ...refuseStoredItems(404, `Item with id '${failure.itemId}' not found.`, { param: 'input', code: null }),
      });
    }

    // The client's own input, not the expansion's `item_reference` prefix: the prefix is
    // already in the snapshot this turn inherited, and staging it again would repeat it.
    await store.stageInputItems(client.input);

    prepared(hydrated.payload);
    return await next({
      ...facts,
      'request.chat.responses': move(hydrated.payload),
      'request.chat.responses.privatePayloads': move([...hydrated.privatePayloads]),
    });
  },
});

/**
 * Reseeds the store's per-attempt scratchpad from what the membrane hydrated.
 *
 * Below the fork because it is per attempt: what one attempt wrote into the scratchpad is
 * not what the next one starts from, and re-running the suffix is what clears it. Nothing in
 * a pipelined turn writes to it yet — the server-tool shim is what writes, and it is still
 * an interceptor — so today this only puts back the state the stored rows already carried,
 * which is what lets an item this turn re-emits be stored with it intact.
 */
export const beginStoredAttempt = defineStage<
  R<'request.chat.responses.privatePayloads'>,
  R<'request.chat.responses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'beginStoredAttempt',
  through: {
    request: { needs: ['request.chat.responses.privatePayloads'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    use.gateway.store.beginAttempt(new Map(facts['request.chat.responses.privatePayloads']));
    return await next(facts);
  },
});

export type ResponsesServeEntry = R<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.responses.wantsStream'
  | 'request.chat.responses' | 'serve.model'
>;

export type ResponsesServeExit = R<
  'response.chat.responses.rendered' | 'response.chat.responses.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const responsesServePipeline = (
  payload: CanonicalResponsesPayload,
  // SSE is what a run is written in when nothing else claims its frames, which is every
  // entry over an HTTP body; the WebSocket transport says so because it writes its own.
  framing: ResponsesStreamFraming = 'sse',
): Pipeline<ResponsesServeEntry, ResponsesServeExit> => {
  // One cell per run, written by the stage directly above the one that reads it. The
  // resolver takes its narrowing at assembly, so this is where the prepared payload crosses
  // from the membrane to the affinity walk; until the membrane has run, what the client sent
  // is the whole of what is known about the turn.
  let prepared = payload;
  return compose('responsesServe', [
    emitResponses(payload, framing),
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.responses'?: unknown })['response.chat.responses']),
      handedUp => (handedUp as { 'response.chat.responses.streamedUsage'?: unknown })['response.chat.responses.streamedUsage'] !== null,
    ),
    hydrateStoredItems(payload, hydrated => { prepared = hydrated; }),
    resolveChatCandidates(responsesNarrowing(() => prepared)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.responses'?: unknown })['response.chat.responses']),
      owns: [],
    }),
    materializeAttempt('request.chat.responses'),
    beginStoredAttempt,
    disableReasoningOnForcedToolChoiceForResponses,
    stripPromptCacheKeyForResponses,
    vendorDeepSeekNormalizeForResponses,
    vendorQwenNormalizeForResponses,
    dialChatWire({
      source: 'request.chat.responses',
      needs: ['request.chat.responses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.responses', RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => responsesTarget.pick(endpoints),
      wire: responsesWireFor,
    }),
  ]);
};
