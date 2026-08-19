// OpenAI Responses as a pipeline, on the chain OpenAI Chat Completions established.
//
//   emitOpenAIResponses    the edge: writes the answer in the shape the client asked for
//   writeSettlement        above the fork, so a run bills once however many wires it tried
//   hydrateStoredItems     the stored-items membrane, on the way in
//   resolveChatCandidates  narrows to what can serve, in the order affinity asks for
//   failover               runs what follows once per candidate
//   materializeAttempt     puts the payload this candidate is owed into the record
//   beginStoredAttempt     reseeds the store's per-attempt scratchpad
//   expandShimCompactions  a compaction this gateway wrote, back into what it stood for
//   summarizeForCompaction answers a turn that asked for a compaction with one
//   runOpenAIResponsesServerTools  a hosted tool the upstream cannot serve, emulated here
//   dialChatWire           the ending: picks this candidate's wire and hands into it
//
// Three wires, all handing up `response.chat.openaiResponses`: this protocol's own, and the two
// translated ones — OpenAI Responses via Anthropic Messages and via OpenAI Chat Completions — each a
// handoff followed by that protocol's own wire. What sits *in* a wire rather than above the
// fork is a rule that speaks about that wire: the role rewrite and the cache-bucket fold both
// do, and position is what says so — a stage below the fork runs only on the wire the fork
// chose, so neither needs a guard about which protocol it is looking at.
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
//     this one's membrane, its narrowing, its wires and the two shim rules below, because a
//     compaction routes and is rewritten exactly as a turn is. The dial here asks for
//     `generate`; what the ending answers with is the branch the provider says it ran, which
//     is why the envelope a compaction is arrives somewhere rather than nowhere.
//
// One deliberate difference from the surface this replaced, shared with every other family: an
// upstream that refused is answered in its own words, with the status it sent, rather than
// being quoted back inside an envelope this gateway wrote.

import { analyzeOpenAIResponsesAffinity } from './affinity/ingress.ts';
import { wrapOpenAIResponsesClientEgress } from './client-output.ts';
import {
  buildCompactionEnvelope,
  containsCompactionTrigger,
  EMPTY_SUMMARY_MESSAGE,
  expandShimCompactionItems,
  summarizationTurnFor,
  summaryTextFrom,
} from './compact-shim.ts';
import type { OpenAIResponsesServeFailure } from './errors.ts';
import { hydrateOpenAIResponsesPayload } from './items/hydrate.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { syntheticEventsFromResult } from './items/output.ts';
import { expandPreviousResponseId, PreviousResponseNotFoundError } from './serve-prep.ts';
import { imageGenerationServerTool } from './server-tools/image-generation.ts';
import { runOpenAIResponsesServerTools } from './server-tools/stage.ts';
import { webSearchServerTool } from './server-tools/web-search.ts';
import { billableUsageFromOpenAIResponsesEvent, billableUsageFromOpenAIResponsesResult } from './usage.ts';
import { recordStream, streamReferenceOf } from '../../../dump/run-sink.ts';
import { bodyForAttempt } from '../../pipeline/attempt-body.ts';
import type { AttemptSelector, BillableEntity } from '../../pipeline/facts.ts';
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
import { openaiChatCompletionsWire } from '../openai-chat-completions/pipeline.ts';
import {
  applyRoleCompatibilityToOpenAIResponses,
  disableReasoningOnForcedToolChoiceForOpenAIResponses,
  normalizeExclusiveCachedTokensForOpenAIResponses,
  stripPromptCacheKeyForOpenAIResponses,
  vendorDeepSeekNormalizeForOpenAIResponses,
  vendorQwenNormalizeForOpenAIResponses,
} from '../rules.ts';
import { applyRulesToUpstreamOpenAIResponses } from '../shared/alias-rules.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import { isFirstOutputTokenFrame } from '../shared/first-output-token.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { materializeAttempt, resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defer, defineStage, move, type Deferred, type Pipeline, type Stage, type Use } from '@floway-dev/pipeline';
import { doneFrame, eventFrame, sseFrame, type BillableUsage, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  collectOpenAIResponsesProtocolEventsToResult,
  createRandomOpenAIResponsesItemId,
  isOpenAIResponsesTerminalEvent,
  openaiResponsesProtocolFrameToSSEFrame,
  OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE,
  type CanonicalOpenAIResponsesPayload,
  type ClientResponseResource,
  type ClientOpenAIResponsesStreamEvent,
  type OpenAIResponsesOutputItem,
  type OpenAIResponsesStreamEvent,
} from '@floway-dev/protocols/openai-responses';
import { providerModelOf, toInternalDebugError, type ChatTargetApi, type ModelCandidate, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateOpenAIResponsesViaOpenAIChatCompletions, translateOpenAIResponsesViaAnthropicMessages } from '@floway-dev/translate';

/** `/v1/responses` prefers its own wire, then the translated Anthropic Messages path, then
 *  the translated OpenAI Chat Completions path. */
export const openaiResponsesTarget = chatTargetPicker(['openaiResponses', 'anthropicMessages', 'openaiChatCompletions']);

/** How the transport that opened the run frames a streamed answer. Both carry this
 *  protocol's own events and neither adds or drops one: SSE is the format an HTTP body is
 *  written in, terminator and all, and a WebSocket turn writes each event as a text frame of
 *  its own — so the transport that owns the socket takes the events and frames them itself. */
export type OpenAIResponsesStreamFraming = 'sse' | 'events';

/** What this family adds to the chat space. */
export interface OpenAIResponsesFacts extends ChatFacts {
  /** Server-only state the gateway once attached to an item it emitted, keyed by that
   *  item's id, as the rows this turn hydrated carry it. It never reaches an upstream: it is
   *  what lets an item this turn re-emits be stored with the state it already had.
   *
   *  Pairs rather than a `Map`, for the same reason the header keys are: a `Map` has no own
   *  properties, so it would be written into the dump as an empty object and the record would
   *  say the turn hydrated nothing. */
  'request.chat.openaiResponses.privatePayloads': readonly (readonly [string, unknown])[];
  /** What the client is actually sent — an object when it asked for one, and the stream it
   *  asked to be streamed, in the framing its transport writes. The edge provides it, so a
   *  dump shows what the client received. */
  'response.chat.openaiResponses.rendered': Record<string, unknown> | AsyncIterable<SseFrame> | AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.openaiResponses.streamedUsage': Deferred<StreamOutcome> | null;
}

type R<K extends keyof OpenAIResponsesFacts> = { [P in K]: OpenAIResponsesFacts[P] };

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
const emitOpenAIResponses = (client: CanonicalOpenAIResponsesPayload, framing: OpenAIResponsesStreamFraming) => defineStage<
  R<'ingress.chat.openaiResponses.wantsStream'>,
  R<'ingress.chat.openaiResponses.wantsStream'>,
  R<'ingress.chat.openaiResponses.wantsStream' | 'response.chat.openaiResponses' | 'response.http.headers'>,
  R<'response.chat.openaiResponses.rendered' | 'response.http.status' | 'response.http.headers'>,
  ChatServices
>({
  name: 'emitOpenAIResponses',
  through: {
    request: { needs: ['ingress.chat.openaiResponses.wantsStream'], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.openaiResponses', 'response.http.headers'],
      consumes: ['response.chat.openaiResponses', 'response.http.headers'],
      provides: ['response.chat.openaiResponses.rendered', 'response.http.status', 'response.http.headers'],
    },
  },
  execute: async (facts, next, use) => {
    const back = await next(facts);
    const { 'response.chat.openaiResponses': answer, 'response.http.headers': headers, ...rest } = back;
    // Vendor traces and quota state stay visible; what an intermediary must strip, and what
    // would misdescribe a body this gateway serialized itself, does not. A filter that removed
    // nothing hands the same array on, so the record shows no change where none happened.
    const forwardable = headers.filter(([name]) => isForwardableUpstreamHeader(name));
    const forClient = forwardable.length === headers.length ? headers : move(forwardable);

    if (isFailure(answer)) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.openaiResponses.rendered': move(renderFailure(
          answer,
          () => ({ error: { message: answer.message, type: 'api_error' } }),
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
        'response.chat.openaiResponses.rendered': move(answer.body as Record<string, unknown>),
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
    const egress = wrapOpenAIResponsesClientEgress(
      answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
      use.gateway,
      client,
    );
    // The record is teed above all of that, which is what makes it a record of what the client
    // was served rather than of what some layer below had still to rewrite. One tee covers both
    // shapes this edge hands out itself, because both read the same iterable: the SSE body, and
    // the object the fold assembles from the frames that would have gone out.
    //
    // Both transports too. A WebSocket turn is the same frames rendered differently, so it is
    // recorded here rather than where it is framed — one tee for the family, whatever writes
    // what it hands up. Reading is what records, so a transport that stopped early records
    // exactly what it took.
    const frames = recordStream(egress, use.gateway.dump);
    if (!back['ingress.chat.openaiResponses.wantsStream']) {
      try {
        return {
          ...rest,
          'response.http.headers': forClient,
          'response.chat.openaiResponses.rendered': move(
            await collectOpenAIResponsesProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
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
          'response.chat.openaiResponses.rendered': move(internalErrorEnvelope(error)),
          'response.http.status': 502,
        };
      }
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.openaiResponses.rendered': move(framing === 'sse' ? renderSSE(frames) : frames),
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
const streamErrorEvent = (error: unknown): ClientOpenAIResponsesStreamEvent => {
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
  } as unknown as ClientOpenAIResponsesStreamEvent;
};

/** "Any error incurred while streaming will be followed by a `response.failed` event."
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx#L430 */
const streamFailedEvent = (announced: ClientResponseResource, error: unknown): ClientOpenAIResponsesStreamEvent => {
  const debug = toInternalDebugError(error);
  return {
    type: 'response.failed',
    response: { ...announced, status: 'failed', error: { code: debug.type, message: debug.message } },
  } as ClientOpenAIResponsesStreamEvent;
};

/** Every OpenAI Responses event has an SSE form of its own, so the render is a straight map. What
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
const renderSSE = (frames: AsyncIterable<ProtocolFrame<ClientOpenAIResponsesStreamEvent>>): AsyncIterable<SseFrame> => ({
  // The frames the client reads are a reframing of the ones the record holds, so this key
  // points at that same stream rather than at nothing.
  ...streamReferenceOf(frames),
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
        yield openaiResponsesProtocolFrameToSSEFrame(frame);
      }
      yield openaiResponsesProtocolFrameToSSEFrame(doneFrame());
    } catch (error) {
      yield sseFrame(JSON.stringify(streamErrorEvent(error)), 'error');
      // Nothing was announced when the break came before the first resource-bearing event,
      // and there is no response to restate as failed.
      if (announced !== undefined) {
        yield openaiResponsesProtocolFrameToSSEFrame(eventFrame(streamFailedEvent(announced, error)));
      }
    }
  })(),
});

/**
 * The wire. It dials OpenAI Responses and provides the answer at whichever family's response key the
 * chain above it reads — which is what makes it interchangeable with a translated chain: both
 * hand up `response.chat.openaiResponses`, and the stage above cannot tell which ran.
 */
const callOpenAIResponsesUpstream = defineStage<
  R<'request.chat.openaiResponses' | 'route.attempt' | 'ingress.http.headers'>,
  R<'response.chat.openaiResponses' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callOpenAIResponsesUpstream',
  return: {
    provides: [
      'response.chat.openaiResponses',
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
    // whole reason a turn can be pinned at all.
    //
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to, which is the one a wire takes.
    const asked = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const body = bodyForAttempt(asked, candidate, applyRulesToUpstreamOpenAIResponses);

    let result;
    try {
      result = await candidate.provider.instance.callOpenAIResponses(
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
        'response.chat.openaiResponses': { status: 502, message: error instanceof Error ? error.message : String(error) },
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
        'response.chat.openaiResponses': {
          status: result.response.status,
          message: text,
          ...(parsed === undefined ? {} : { body: parsed }),
        },
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
        'response.chat.openaiResponses': { kind: 'value' as const, body: result.result },
        'response.usage.billable': [billedOpenAIResponsesEntity(identity, billableUsageFromOpenAIResponsesResult(result.result) ?? undefined)],
        'response.http.headers': [],
      });
    }

    return move({
      ...facts,
      'response.chat.openaiResponses': { kind: 'stream' as const, frames: result.events },
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/**
 * What an upstream's OpenAI Responses endpoint accepts on an assistant item it produced itself.
 * Copilot's compaction translation and Azure-native compaction both emit assistant messages
 * whose content blocks carry `type: 'input_text'`, and both then refuse those same items
 * echoed back as input on the next turn. Every way prior upstream-produced history reaches a
 * wire arrives here — a direct client echo, the snapshot the membrane expanded, a compaction
 * tail — so this is the one place the canonical assistant content type is put back.
 *
 * Only this wire needs it. Both translators read `input_text` and `output_text` the same way
 * on assistant content, so a turn that leaves for Anthropic Messages or OpenAI Chat Completions never carried
 * the disagreement in the first place.
 */
const normalizeAssistantContentForOpenAIResponses = defineStage<
  R<'request.chat.openaiResponses'>,
  R<'request.chat.openaiResponses'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'normalizeAssistantContentForOpenAIResponses',
  through: {
    request: { needs: ['request.chat.openaiResponses'], consumes: [], provides: ['request.chat.openaiResponses'] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next) => {
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const input = normalizeAssistantInputText(payload.input);
    // A rewrite that changed nothing hands the same payload on, so the record shows no
    // change where none happened.
    if (input === payload.input) return await next(facts);
    return await next({ ...facts, 'request.chat.openaiResponses': move({ ...payload, input }) });
  },
});

/**
 * What every turn this wire sends is subject to, whichever operation asked for it.
 *
 * Every source protocol that reaches an upstream over this endpoint runs these, whether the
 * client spoke OpenAI Responses or a handoff arrived here — which is what makes the three rules
 * belong to the wire. The role rewrite and the assistant-content rewrite both state what an
 * upstream's OpenAI Responses endpoint accepts; the cache-bucket fold speaks about the usage *this*
 * wire reports and about the flag that describes it, and a translator emits the canonical
 * form, which is the one case the fold has nothing to do with.
 *
 * They are named apart from the dial because a compaction is dialled differently and is
 * subject to the same three.
 */
export const openaiResponsesWireRules: readonly Stage[] = [
  normalizeAssistantContentForOpenAIResponses,
  disableReasoningOnForcedToolChoiceForOpenAIResponses,
  applyRoleCompatibilityToOpenAIResponses,
  stripPromptCacheKeyForOpenAIResponses,
  normalizeExclusiveCachedTokensForOpenAIResponses,
  vendorDeepSeekNormalizeForOpenAIResponses,
  vendorQwenNormalizeForOpenAIResponses,
];

/** The OpenAI Responses wire, as the chain that dials it. The meter is above every rule, which
 *  is what makes the figure it bills the one the client is shown. */
export const openaiResponsesWire = (streamedUsage: string): readonly Stage[] => [
  meterChatWire({
    wire: 'openaiResponses',
    answer: 'response.chat.openaiResponses',
    streamedUsage,
    read: meterOpenAIResponses,
  }),
  ...openaiResponsesWireRules,
  callOpenAIResponsesUpstream,
];

/** This family's own reading, which every wire under it hands up. */
export const OPENAI_RESPONSES_STREAMED_USAGE = 'response.chat.openaiResponses.streamedUsage';

/** The three wires `/v1/responses` can be served on. Its own is the bare wire; each translated
 *  one is a handoff and then the target protocol's own wire. */
export const openaiResponsesWireFor = (target: ChatTargetApi, candidate: ModelCandidate, use: Use<ChatServices>): ChatWire => {
  switch (target) {
  case 'openaiResponses':
    return compose('openaiResponsesNative', openaiResponsesWire(OPENAI_RESPONSES_STREAMED_USAGE));
  case 'anthropicMessages':
    return compose('openaiResponsesViaAnthropicMessages', [
      handOff({
        from: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        to: { request: 'request.chat.anthropicMessages', response: 'response.chat.anthropicMessages' },
        trip: async payload => await translateOpenAIResponsesViaAnthropicMessages(payload, {
          model: candidate.model.id,
          fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
          loadRemoteImage: createExternalImageLoader(use.gateway.abortSignal),
        }),
      }),
      ...anthropicMessagesWire(OPENAI_RESPONSES_STREAMED_USAGE),
    ]);
  case 'openaiChatCompletions':
    return compose('openaiResponsesViaOpenAIChatCompletions', [
      handOff({
        from: { request: 'request.chat.openaiResponses', response: 'response.chat.openaiResponses' },
        to: { request: 'request.chat.openaiChatCompletions', response: 'response.chat.openaiChatCompletions' },
        trip: async payload => await translateOpenAIResponsesViaOpenAIChatCompletions(payload, { model: candidate.model.id }),
      }),
      ...openaiChatCompletionsWire(OPENAI_RESPONSES_STREAMED_USAGE),
    ]);
  }
};

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. OpenAI Responses states its counts on the
 *  lifecycle envelopes, and only one carrying real counts replaces the running figure, so an
 *  envelope that states none cannot wipe a good reading. */
const meterOpenAIResponses = (
  source: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>,
  identity: TelemetryModelIdentity,
  attempt: { firstOutputTokenAt: number | null },
): { readonly frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>; readonly outcome: Deferred<StreamOutcome> } => {
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
        if (attempt.firstOutputTokenAt === null && isFirstOutputTokenFrame(frame, 'openaiResponses')) {
          attempt.firstOutputTokenAt = performance.now();
        }
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const usage = billableUsageFromOpenAIResponsesEvent(frame.event);
        if (usage !== null) reported = usage;
        // Read off the frame rather than off having been resumed past it. The stage that
        // stores the turn's items stops reading at the terminal event, so the resumption
        // never comes: what this loop would learn from it is already true when the frame
        // arrives, and the turn ended the way the upstream said it did whether or not
        // anything downstream asked for another.
        if (isOpenAIResponsesTerminalEvent(frame.event)) sawTerminal = true;
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past its terminal event would otherwise hold the client's stream
        // open with it; returning here closes the read, which cancels the upstream.
        if (sawTerminal) return;
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // response was never stated complete, incomplete or failed.
      throw new Error(OPENAI_RESPONSES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle({ billable: [billedOpenAIResponsesEntity(identity, reported)], failed: !sawTerminal });
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
export const billedOpenAIResponsesEntity = (identity: TelemetryModelIdentity, usage: BillableUsage | undefined): BillableEntity => {
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
export const openaiResponsesNarrowing = (prepared: () => CanonicalOpenAIResponsesPayload): ChatNarrowing<R<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage'>> => ({
  canServe: candidate => openaiResponsesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeOpenAIResponsesAffinity(prepared(), gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /responses endpoint.`,
  refuse: (status, message, reason) => ({
    'response.chat.openaiResponses.streamedUsage': null,
    'response.chat.openaiResponses': {
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
  refuses: ['response.chat.openaiResponses', 'response.chat.openaiResponses.streamedUsage'],
});

/** A refusal the membrane makes on its own, in the shape every other refusal in this chain
 *  takes: an empty billed set and empty headers are what "no upstream was called" looks like
 *  on those two keys, and the envelope is what an OpenAI client reads. */
const refuseStoredItems = (
  status: number,
  message: string,
  extra: { readonly param: string; readonly code: string | null },
): R<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'> => ({
  'response.usage.billable': [],
  'response.http.headers': [],
  'response.chat.openaiResponses.streamedUsage': null,
  'response.chat.openaiResponses': {
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
  client: CanonicalOpenAIResponsesPayload,
  prepared: (payload: CanonicalOpenAIResponsesPayload) => void,
) => defineStage<
  R<'request.chat.openaiResponses'>,
  R<'request.chat.openaiResponses' | 'request.chat.openaiResponses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  R<'response.chat.openaiResponses' | 'response.chat.openaiResponses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'hydrateStoredItems',
  through: {
    request: {
      needs: ['request.chat.openaiResponses'],
      consumes: [],
      provides: ['request.chat.openaiResponses', 'request.chat.openaiResponses.privatePayloads'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  return: {
    provides: [
      'response.chat.openaiResponses',
      'response.chat.openaiResponses.streamedUsage',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, next, use) => {
    const store = use.gateway.store;
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to.
    const asked = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;

    let expanded: CanonicalOpenAIResponsesPayload;
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

    let hydrated: ReturnType<typeof hydrateOpenAIResponsesPayload>;
    try {
      hydrated = hydrateOpenAIResponsesPayload(expanded, store);
    } catch (error) {
      const failure = tryCatchChatServeFailure<OpenAIResponsesServeFailure>(error);
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
      'request.chat.openaiResponses': move(hydrated.payload),
      'request.chat.openaiResponses.privatePayloads': move([...hydrated.privatePayloads]),
    });
  },
});

/**
 * Reseeds the store's per-attempt scratchpad from what the membrane hydrated.
 *
 * Below the fork because it is per attempt: what one attempt wrote into the scratchpad is
 * not what the next one starts from, and re-running the suffix is what clears it. Nothing in
 * a pipelined turn writes to it — the server-tool shim is what writes, and it does not run at
 * all — so today this only puts back the state the stored rows already carried, which is what
 * lets an item this turn re-emits be stored with it intact.
 */
export const beginStoredAttempt = defineStage<
  R<'request.chat.openaiResponses.privatePayloads'>,
  R<'request.chat.openaiResponses.privatePayloads'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'beginStoredAttempt',
  through: {
    request: { needs: ['request.chat.openaiResponses.privatePayloads'], consumes: [], provides: [] },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    use.gateway.store.beginAttempt(new Map(facts['request.chat.openaiResponses.privatePayloads']));
    return await next(facts);
  },
});

// ── The compact shim ──────────────────────────────────────────────────────────────────────
//
// Two rules, composed by both of this protocol's chains, because a compaction the shim wrote
// is issued through one entry and read back through the other: Codex asks for one by ending
// a generate turn's input with a `compaction_trigger`, `/v1/responses/compact` asks for one
// by being called at all, and either way the envelope comes back to the client, who echoes it
// into the ordinary turns that follow. What the shim is, what it vendors and what it cannot
// reproduce is at `compact-shim.ts`.

/**
 * Whether this candidate's compactions are the shim's to simulate.
 *
 * Two ways to be, and an upstream only has to be one of them. The operator opted an OpenAI Responses
 * upstream in with `responses-compact-shim`, which is the say-so for one that would answer a
 * compaction itself. Or the candidate has no OpenAI Responses endpoint at all: no translation
 * carries a compaction, so an Anthropic Messages or OpenAI Chat Completions candidate has neither a compaction
 * to dial nor a translator that models the item asking for one — the shim is structurally
 * required there rather than chosen.
 *
 * One reading, taken wherever the question is asked, so a turn that asks for a compaction on
 * its way through generation is answered with the compaction this protocol's own endpoint
 * would have produced for it.
 */
export const simulatesCompaction = (candidate: ModelCandidate, attempt: AttemptSelector): boolean =>
  openaiResponsesTarget.pick(candidate.model.endpoints) !== 'openaiResponses'
  || attempt.flags.includes('responses-compact-shim');

/**
 * Expands a compaction this gateway wrote back into the history it stood for.
 *
 * The shim's envelope carries the items it summarized, so a turn that echoes one back is sent
 * that history rather than an opaque blob the upstream has no key for. A blob this gateway
 * did not write — a native upstream's own encrypted compaction — fails the decode and rides
 * through untouched, which is what lets an operator turn the flag off for an upstream that
 * compacts natively.
 *
 * Gated on the same reading the endings take: only an upstream whose compactions this gateway
 * simulates can be holding one of ours, and a native one is owed its own blob verbatim.
 */
export const expandShimCompactions = defineStage<
  R<'request.chat.openaiResponses' | 'route.attempt'>,
  R<'request.chat.openaiResponses'>,
  Record<string, never>,
  Record<string, never>,
  ChatServices
>({
  name: 'expandShimCompactions',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: { needs: [], consumes: [], provides: [] },
  },
  execute: async (facts, next, use) => {
    if (!simulatesCompaction(use.resolveAttempt(facts['route.attempt']), facts['route.attempt'])) {
      return await next(facts);
    }
    // The key holds what a client may send, whose `input` is a string or a list; this chain
    // runs on the canonical form the entry normalized it to.
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const expanded = expandShimCompactionItems(payload);
    // A turn carrying none of ours hands the same payload on, so the record shows no change
    // where none happened.
    if (expanded === payload) return await next(facts);
    return await next({ ...facts, 'request.chat.openaiResponses': move(expanded) });
  },
});

/** How the chain that composed the stage below says a turn reaching it asked for a compaction.
 *  It is the whole gate, so each chain states its own: what asks for a compaction differs by
 *  operation, and no action travels in the record for the stage to read instead. */
export type CompactionAsk = (
  facts: R<'request.chat.openaiResponses' | 'route.attempt'>,
  use: Use<ChatServices>,
) => boolean;

/**
 * Answers a turn that asked for a compaction with one, over an upstream that has no
 * compaction wire.
 *
 * It rewrites the turn on the way down — the compactor's prompt at the head of the history,
 * the trigger stripped, a terminal nudge appended, nothing persisted upstream — and folds the
 * generated summary into an envelope of this gateway's own on the way back. Below it is the
 * ordinary generate fork, which is what makes every wire generation can take a wire a
 * compaction can be simulated over.
 *
 * What the simulation cannot reproduce is stated where it happens, at `summarizationTurnFor`.
 */
export const summarizeForCompaction = (asked: CompactionAsk) => defineStage<
  R<'request.chat.openaiResponses' | 'route.attempt'>,
  R<'request.chat.openaiResponses'>,
  R<'response.chat.openaiResponses'>,
  R<'response.chat.openaiResponses'>,
  ChatServices
>({
  name: 'summarizeForCompaction',
  through: {
    request: {
      needs: ['request.chat.openaiResponses', 'route.attempt'],
      consumes: [],
      provides: ['request.chat.openaiResponses'],
    },
    response: {
      needs: ['response.chat.openaiResponses'],
      consumes: [],
      provides: ['response.chat.openaiResponses'],
    },
  },
  execute: async (facts, next, use) => {
    if (!asked(facts, use)) return await next(facts);
    const payload = facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload;
    const back = await next({ ...facts, 'request.chat.openaiResponses': move(summarizationTurnFor(payload)) });

    const answer = back['response.chat.openaiResponses'];
    // An upstream that refused is handed on as it came: the client learns the compaction
    // failed rather than being given a silent empty envelope. One that answered with a single
    // envelope compacted on its own, and an envelope is already the answer — there are no
    // frames to fold and nothing this layer could add to it.
    if (isFailure(answer) || answer.kind !== 'stream') return back;

    // The item lifecycle is the authority on what the turn closed; a Codex upstream states an
    // `output` on its terminal that omits the message it just closed, so both are read and
    // the closed items win where there are any.
    const closed = new Map<number, OpenAIResponsesOutputItem>();
    const observed = (async function* (): AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>> {
      for await (const frame of answer.frames as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEvent>>) {
        if (frame.type === 'event' && frame.event.type === 'response.output_item.done') {
          closed.set(frame.event.output_index, frame.event.item);
        }
        yield frame;
      }
    })();
    const collected = await collectOpenAIResponsesProtocolEventsToResult(observed);

    const summaryText = summaryTextFrom(closed, collected.output);
    if (summaryText.length === 0) {
      // A summarization that closed no text produced no summary, and the blob is the whole of
      // what the next turn inherits — so this is a candidate that did not do the job rather
      // than a fault that ends the request, and the fork can try another.
      return { ...back, 'response.chat.openaiResponses': move({ status: 502, message: EMPTY_SUMMARY_MESSAGE }) };
    }

    const synthesized = buildCompactionEnvelope(createRandomOpenAIResponsesItemId('compaction'), summaryText, collected);
    return { ...back, 'response.chat.openaiResponses': move({ kind: 'stream' as const, frames: syntheticEventsFromResult(synthesized) }) };
  },
});

/**
 * What asking for a compaction looks like on this chain.
 *
 * Codex's RemoteCompactionV2 path asks for one inside an ordinary turn, by ending its input
 * with the control item that requests it — so this chain reads the request rather than the
 * operation, and reads it per turn. Where the shim is not this candidate's to run, the item
 * travels on to an upstream whose own `/responses` endpoint answers it, which is what a
 * native OpenAI Responses upstream does with it.
 */
const asksForCompaction: CompactionAsk = (facts, use) =>
  containsCompactionTrigger((facts['request.chat.openaiResponses'] as CanonicalOpenAIResponsesPayload).input)
  && simulatesCompaction(use.resolveAttempt(facts['route.attempt']), facts['route.attempt']);

export type OpenAIResponsesServeEntry = R<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.openaiResponses.wantsStream'
  | 'request.chat.openaiResponses' | 'serve.model'
>;

export type OpenAIResponsesServeExit = R<
  'response.chat.openaiResponses.rendered' | 'response.chat.openaiResponses.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const openaiResponsesServePipeline = (
  payload: CanonicalOpenAIResponsesPayload,
  // SSE is what a run is written in when nothing else claims its frames, which is every
  // entry over an HTTP body; the WebSocket transport says so because it writes its own.
  framing: OpenAIResponsesStreamFraming = 'sse',
): Pipeline<OpenAIResponsesServeEntry, OpenAIResponsesServeExit> => {
  // One cell per run, written by the stage directly above the one that reads it. The
  // resolver takes its narrowing at assembly, so this is where the prepared payload crosses
  // from the membrane to the affinity walk; until the membrane has run, what the client sent
  // is the whole of what is known about the turn.
  let prepared = payload;
  return compose('openaiResponsesServe', [
    emitOpenAIResponses(payload, framing),
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.openaiResponses'?: unknown })['response.chat.openaiResponses']),
      handedUp => (handedUp as { 'response.chat.openaiResponses.streamedUsage'?: unknown })['response.chat.openaiResponses.streamedUsage'] !== null,
    ),
    hydrateStoredItems(payload, hydrated => { prepared = hydrated; }),
    resolveChatCandidates(openaiResponsesNarrowing(() => prepared)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.openaiResponses'?: unknown })['response.chat.openaiResponses']),
      owns: [],
    }),
    materializeAttempt('request.chat.openaiResponses'),
    beginStoredAttempt,
    expandShimCompactions,
    summarizeForCompaction(asksForCompaction),
    // Directly above the dial, because every descent it makes is another dial of this same
    // candidate: a hosted tool the upstream does not implement is emulated by asking again with
    // the tool's result folded back in, and the frames of every ask are spliced into one turn.
    runOpenAIResponsesServerTools([webSearchServerTool, imageGenerationServerTool], {
      streamedUsage: OPENAI_RESPONSES_STREAMED_USAGE,
      targetOf: candidate => openaiResponsesTarget.pick(candidate.model.endpoints),
    }),
    dialChatWire({
      source: 'request.chat.openaiResponses',
      needs: ['request.chat.openaiResponses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      provides: ['response.chat.openaiResponses', OPENAI_RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
      pick: endpoints => openaiResponsesTarget.pick(endpoints),
      wire: openaiResponsesWireFor,
    }),
  ]);
};
