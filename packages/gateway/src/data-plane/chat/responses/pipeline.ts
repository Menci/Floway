// Responses as a pipeline, on the chain Chat Completions established.
//
//   emitResponses          the edge: writes the answer in the shape the client asked for
//   writeSettlement        above the fork, so a run bills once however many wires it tried
//   resolveChatCandidates  narrows to what can serve, in the order affinity asks for
//   failover               runs what follows once per candidate
//   callResponsesUpstream  the ending: dials this candidate's wire
//
// One wire and one transport: `/v1/responses` over HTTP, dialled on a candidate's own
// Responses endpoint. Everything else this protocol owns is a step of its own, and is stated
// here rather than implied by its absence:
//
//   - the WebSocket transport. A second entry against this protocol — its own framing, its
//     own lifecycle — and `websocket.ts` still owns it.
//   - `/v1/responses/compact`. A second operation over this protocol rather than another
//     wire under this pipeline, so it stays on `responsesServe.compact`. The dial here asks
//     for `generate`; what the ending answers with is the branch the provider says it ran,
//     which is why the envelope a compaction is arrives somewhere rather than nowhere.
//   - the translated wires, Responses via Messages and via Chat Completions. Each hands up
//     the same `response.chat.responses` key, which is what will make them interchangeable
//     with this one.
//   - this family's interceptors, the server-tool shims among them. Still only in the
//     interceptor form, so the array between the fork and the ending is empty rather than
//     short.
//   - the stored-items membrane: `previous_response_id` expansion, item hydration, and the
//     snapshot the next turn reads. It wraps the chain rather than sitting in it, and
//     `serve-prep.ts` and `client-output.ts` still hold it.
//
// One deliberate difference from `respond.ts`, shared with every other family on the
// pipeline: an upstream that refused is answered in its own words, with the status it sent,
// rather than being quoted back inside an envelope this gateway wrote. And one that is this
// family's own: a stream that runs out before its terminal event still ends the run with
// `RESPONSES_MISSING_TERMINAL_MESSAGE`, but nothing turns that into the mid-stream `error`
// and `response.failed` pair `respond.ts` wrote for a client already being streamed to.

import { analyzeResponsesAffinity } from './affinity/ingress.ts';
import { billableUsageFromResponsesEvent, billableUsageFromResponsesResult } from './usage.ts';
import type { BillableEntity } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { tokenUsageFromBillableUsage, tokenUsageMeasurement } from '../../shared/telemetry/usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import type { ChatFacts } from '../facts.ts';
import { applyRulesToUpstreamResponses } from '../shared/alias-rules.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { resolveChatCandidates, type ChatNarrowing, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import { doneFrame, renderErrorEnvelope, type BillableUsage, type ProtocolFrame, type SseFrame } from '@floway-dev/protocols/common';
import {
  collectResponsesProtocolEventsToResult,
  isResponsesTerminalEvent,
  responsesProtocolFrameToSSEFrame,
  RESPONSES_MISSING_TERMINAL_MESSAGE,
  type CanonicalResponsesPayload,
  type ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';
import { providerModelOf, type TelemetryModelIdentity } from '@floway-dev/provider';

/** `/v1/responses` prefers its own wire, then the translated Messages path, then the
 *  translated Chat Completions path. */
export const responsesTarget = chatTargetPicker(['responses', 'messages', 'chat-completions']);

/** What this family adds to the chat space. */
export interface ResponsesFacts extends ChatFacts {
  /** What the client is actually sent — an object when it asked for one, SSE frames when it
   *  asked to stream. The edge provides it, so a dump shows what the client received. */
  'response.chat.responses.rendered': Record<string, unknown> | AsyncIterable<SseFrame>;
  /** What the upstream will have reported once the frames run out, and `null` when nothing
   *  streamed. Settling from this is the epilogue's job, after the drain. */
  'response.chat.responses.streamedUsage': Promise<readonly BillableEntity[]> | null;
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
 */
const emitResponses = defineStage<
  R<'ingress.chat.responses.wantsStream'>,
  R<'ingress.chat.responses.wantsStream'>,
  R<'ingress.chat.responses.wantsStream' | 'response.chat.responses' | 'response.http.headers'>,
  R<'response.chat.responses.rendered' | 'response.http.status' | 'response.http.headers'>
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
  execute: async (facts, next) => {
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
        'response.chat.responses.rendered': move(renderErrorEnvelope(answer.message, answer.body)),
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

    const frames = answer.frames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>;
    if (!back['ingress.chat.responses.wantsStream']) {
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.responses.rendered': move(
          await collectResponsesProtocolEventsToResult(frames) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
      };
    }
    return {
      ...rest,
      'response.http.headers': forClient,
      'response.chat.responses.rendered': move(renderSSE(frames)),
      'response.http.status': 200,
    };
  },
});

/** Every Responses event has an SSE form of its own, so the render is a straight map. What
 *  it adds is the terminator: the client's stream ends on the literal `[DONE]` payload
 *  whether or not the upstream's stream carried one, because that is what the transport
 *  reads to know the turn is over.
 *  https://github.com/openresponses/openresponses/blob/92c12d96d7b61d6d15e2214daa5e9c6000ab6e1c/src/specifications/2026-04-24.mdx?plain=1#L84 */
const renderSSE = (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): AsyncIterable<SseFrame> => ({
  [Symbol.asyncIterator]: () => (async function* () {
    for await (const frame of frames) {
      // The upstream's own terminator is not the client's — the ending stops reading at the
      // turn's terminal event, and one terminator is written below however the frames ended.
      if (frame.type === 'done') continue;
      yield responsesProtocolFrameToSSEFrame(frame);
    }
    yield responsesProtocolFrameToSSEFrame(doneFrame());
  })(),
});

/**
 * The native wire. It dials Responses and provides the answer at this family's own response
 * key — which is what will make it interchangeable with a translated chain: both hand up
 * `response.chat.responses`, and the stage above cannot tell which ran.
 */
const callResponsesUpstream = defineStage<
  R<'request.chat.responses' | 'route.attempt' | 'ingress.http.headers'>,
  R<'response.chat.responses' | 'response.chat.responses.streamedUsage'
  | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callResponsesUpstream',
  return: {
    provides: [
      'response.chat.responses',
      'response.chat.responses.streamedUsage',
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    // Affinity materializes the payload this candidate is owed: client-carried state — an
    // encrypted reasoning blob, a compaction the upstream issued — is rewritten for the
    // upstream that will see it, which is the whole reason a turn can be pinned at all. The
    // id the client addressed does not travel — the provider re-stamps whatever it resolved
    // upstream — and an alias' own rules apply to the body that is sent.
    const asked = use.chatPayloadFor(facts['route.attempt']) as CanonicalResponsesPayload;
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
        'response.chat.responses.streamedUsage': null,
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
        'response.chat.responses.streamedUsage': null,
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
        'response.chat.responses.streamedUsage': null,
        'response.usage.billable': [billed(identity, billableUsageFromResponsesResult(result.result) ?? undefined)],
        'response.http.headers': [],
      });
    }

    const metered = meterResponses(result.events, identity);
    return move({
      ...facts,
      'response.chat.responses': { kind: 'stream' as const, frames: metered.frames },
      'response.chat.responses.streamedUsage': metered.billable,
      'response.usage.billable': called,
      'response.http.headers': [...(result.headers ?? new Headers())],
    });
  },
});

/** Reads the upstream's own usage off its own events as they pass, so the reading costs one
 *  pass and the client's stream is what drives it. Responses states its counts on the
 *  lifecycle envelopes, and only one carrying real counts replaces the running figure, so an
 *  envelope that states none cannot wipe a good reading. */
const meterResponses = (
  source: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  identity: TelemetryModelIdentity,
): { readonly frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>; readonly billable: Promise<readonly BillableEntity[]> } => {
  let settle!: (billable: readonly BillableEntity[]) => void;
  const billable = new Promise<readonly BillableEntity[]>(resolve => { settle = resolve; });
  const generator = (async function* () {
    let reported: BillableUsage | undefined;
    try {
      for await (const frame of source) {
        if (frame.type !== 'event') {
          yield frame;
          continue;
        }
        const usage = billableUsageFromResponsesEvent(frame.event);
        if (usage !== null) reported = usage;
        yield frame;
        // The turn is over, so there is nothing further to read. An upstream that holds the
        // connection open past its terminal event would otherwise hold the client's stream
        // open with it; returning here closes the read, which cancels the upstream.
        if (isResponsesTerminalEvent(frame.event)) return;
      }
      // Frames ran out with no terminal event, which is a turn nobody can answer from: the
      // response was never stated complete, incomplete or failed.
      throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
    } finally {
      // Reached however the frames ended — the terminal event, a client that stopped
      // reading, or a broken upstream — because tokens the upstream already metered are
      // billable whatever happened to the downstream half.
      settle([billed(identity, reported)]);
    }
  })();
  return { frames: { [Symbol.asyncIterator]: () => generator }, billable };
};

/** An upstream that reported nothing leaves no quantities at all, which is a different
 *  statement from reporting zero.
 *
 *  A reading that did arrive is converted rather than cast: a billed entity is keyed by
 *  billing metric, which is not the shape a protocol reports in. The tier rides along
 *  because on this protocol it is not a quantity but a rate selector — `service_tier` states
 *  the tier the turn was actually served at, and that is the pricing entry it is billed
 *  under. */
const billed = (identity: TelemetryModelIdentity, usage: BillableUsage | undefined): BillableEntity => {
  if (usage === undefined) return { identity, quantities: {} };
  const measurement = tokenUsageMeasurement(tokenUsageFromBillableUsage(usage));
  return { identity, quantities: measurement.quantities, pricingFacts: measurement.pricingFacts };
};

/** A candidate that cannot serve *this* request is not a candidate — and what the client's
 *  own turn carries decides the order the rest are tried in, which is why the narrowing is
 *  built from the request rather than being a constant. */
const narrowing = (payload: CanonicalResponsesPayload): ChatNarrowing<R<'response.chat.responses'>> => ({
  source: 'responses',
  canServe: candidate => responsesTarget.canServe(candidate.model.endpoints),
  affinity: async gateway => await analyzeResponsesAffinity(payload, gateway.affinity.codec),
  unsupported: model => `Model ${model} does not support the /responses endpoint.`,
  refuse: (status, message) => ({ 'response.chat.responses': { status, message } }),
  refuses: ['response.chat.responses'],
});

export type ResponsesServeEntry = R<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'ingress.chat.responses.wantsStream'
  | 'request.chat.responses' | 'serve.model'
>;

export type ResponsesServeExit = R<
  'response.chat.responses.rendered' | 'response.chat.responses.streamedUsage'
  | 'response.http.status' | 'response.http.headers' | 'response.usage.billable'
>;

export const responsesServePipeline = (payload: CanonicalResponsesPayload): Pipeline<ResponsesServeEntry, ResponsesServeExit> =>
  compose('responsesServe', [
    emitResponses,
    writeSettlement(
      handedUp => isFailure((handedUp as { 'response.chat.responses'?: unknown })['response.chat.responses']),
      handedUp => (handedUp as { 'response.chat.responses.streamedUsage'?: unknown })['response.chat.responses.streamedUsage'] !== null,
    ),
    resolveChatCandidates(narrowing(payload)),
    failover({
      failed: handedUp => isFailure((handedUp as { 'response.chat.responses'?: unknown })['response.chat.responses']),
      owns: [],
    }),
    callResponsesUpstream,
  ]);
