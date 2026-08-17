// `/v1/responses/compact` as a pipeline.
//
//   emitResponsesCompaction    the edge: persists what the turn emitted and completes the resource
//   writeSettlement            above the fork, so a run bills once however many wires it tried
//   hydrateStoredItems         the stored-items membrane, on the way in
//   resolveChatCandidates      narrows to what can serve, in the order affinity asks for
//   failover                   runs what follows once per candidate
//   materializeAttempt         puts the payload this candidate is owed into the record
//   beginStoredAttempt         reseeds the store's per-attempt scratchpad
//   expandShimCompactions      a compaction this gateway wrote, back into what it stood for
//   this family's request rules, the same four generation runs above its fork
//   dialResponsesCompaction    the ending: dials a compaction, or simulates one
//
// A second **operation** over this protocol rather than another wire under
// `responsesServePipeline`, which is why it is a chain of its own. Everything above the
// ending it shares with generation, stage for stage, because a compaction is routed, pinned
// and rewritten exactly as a turn is: the same membrane hydrates it, the same narrowing
// orders its candidates, the same rules shape the body that goes out — the shim's own
// expansion among them, because a compaction it wrote is echoed back into either entry.
//
// The ending is where the two part. Two wires, both handing up `response.chat.responses`:
//
//   - the compaction wire. An upstream whose own `/responses` endpoint compacts is asked to,
//     and answers with one envelope; the synthetic frames it becomes are what the stateful
//     half above persists items and a response id from.
//   - the simulation. An upstream with no compaction wire of its own — every Messages and
//     Chat Completions candidate, and any Responses candidate an operator opted in with
//     `responses-compact-shim` — is sent an ordinary generate turn against the compactor's
//     prompt over the wires generation would have used, and the summary it produces is packed
//     into an envelope of this gateway's own. That is the whole of what the action pivot was:
//     one wire dials `compact`, the other dials `generate` under the stage that folds the
//     answer, and neither needs an action to travel in the record. The stage is the one the
//     generate chain answers a `compaction_trigger` with, so whichever entry asked, the
//     compaction that comes back was made the same way.
//
// What the simulation cannot reproduce is stated where it happens, at `summarizationTurnFor`.
//
// One thing this chain does not carry, stated rather than implied by its absence: the
// server-tool shim. It is still only an interceptor, so a compaction whose caller declared a
// server tool is summarized without the ReAct loop wrapped around it — the same gap the
// generate chain states, and for the same reason.

import { responsesCreatedAt, wrapResponsesStatefulOutput } from './client-output.ts';
import { completeResponsesCompaction } from './compaction-resource.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import {
  beginStoredAttempt,
  billedResponsesEntity,
  expandShimCompactions,
  hydrateStoredItems,
  internalErrorEnvelope,
  RESPONSES_STREAMED_USAGE,
  responsesNarrowing,
  responsesTarget,
  responsesWireFor,
  responsesWireRules,
  simulatesCompaction,
  summarizeForCompaction,
  type ResponsesFacts,
} from './pipeline.ts';
import { billableUsageFromResponsesResult } from './usage.ts';
import type { Failure } from '../../pipeline/facts.ts';
import { isFailure } from '../../pipeline/facts.ts';
import type { StreamOutcome } from '../../pipeline/serve.ts';
import { writeSettlement } from '../../pipeline/settlement.ts';
import { failover } from '../../pipeline/stages.ts';
import { telemetryModelIdentity, upstreamPerformanceContext } from '../../shared/telemetry/attribution.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { isForwardableUpstreamHeader } from '../../shared/upstream-response.ts';
import { dialChatWire, type ChatWire } from '../handoff.ts';
import {
  disableReasoningOnForcedToolChoiceForResponses,
  stripPromptCacheKeyForResponses,
  vendorDeepSeekNormalizeForResponses,
  vendorQwenNormalizeForResponses,
} from '../interceptors.ts';
import { applyRulesToUpstreamResponses } from '../shared/alias-rules.ts';
import { materializeAttempt, resolveChatCandidates, type ChatServices } from '../stages.ts';
import { compose, defineStage, move, type Pipeline } from '@floway-dev/pipeline';
import { renderProtocolError, type ProtocolFrame } from '@floway-dev/protocols/common';
import {
  collectResponsesProtocolEventsToResult,
  type CanonicalResponsesPayload,
  type ResponsesStreamEvent,
} from '@floway-dev/protocols/responses';
import { providerModelOf } from '@floway-dev/provider';

type R<K extends keyof ResponsesFacts> = { [P in K]: ResponsesFacts[P] };

/** What a compaction wire hands up. A compaction is a stream by the time it leaves either
 *  ending — the envelope is expanded into the events the stateful half reads — so the value
 *  arm this protocol's response key also admits is not one this chain ever produces. */
type Compacted<K extends 'response.chat.responses'> = {
  [P in K]: { readonly kind: 'stream'; readonly frames: AsyncIterable<unknown> } | Failure;
};

/**
 * The outermost edge.
 *
 * A compaction answers with one resource, so the frames never reach a client: they are read
 * here, which is also what stores each item the turn emitted under this gateway's own
 * response id. The resource that comes out is `CompactResource` and not the response
 * resource, so it is completed here rather than by the generate chain's egress — the fields
 * the two require are different, and a compaction decorated with the twenty-odd keys a
 * response resource declares would answer with a shape the spec does not give it.
 */
const emitResponsesCompaction = defineStage<
  Record<string, never>,
  Record<string, never>,
  Compacted<'response.chat.responses'> & R<'response.http.headers' | 'response.chat.responses.streamedUsage'>,
  R<'response.chat.responses.rendered' | 'response.http.status' | 'response.http.headers' | 'response.chat.responses.streamedUsage'>,
  ChatServices
>({
  name: 'emitResponsesCompaction',
  through: {
    request: { needs: [], consumes: [], provides: [] },
    response: {
      needs: ['response.chat.responses', 'response.http.headers', 'response.chat.responses.streamedUsage'],
      consumes: ['response.chat.responses', 'response.http.headers'],
      provides: [
        'response.chat.responses.rendered',
        'response.http.status',
        'response.http.headers',
        'response.chat.responses.streamedUsage',
      ],
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

    try {
      const persisted = await collectResponsesProtocolEventsToResult(
        wrapResponsesStatefulOutput(answer.frames as AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, use.gateway),
      );
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.responses.rendered': move(
          completeResponsesCompaction(persisted, responsesCreatedAt(use.gateway)) as unknown as Record<string, unknown>,
        ),
        'response.http.status': 200,
        'response.chat.responses.streamedUsage': move(
          withVerdict(rest['response.chat.responses.streamedUsage'], compactionFailed(persisted)),
        ),
      };
    } catch (error) {
      // Nothing has gone out yet, so the fault is still a status. A compaction the gateway
      // could not finish — an upstream that stated no counts, a turn that could not be
      // stored — is not one it can answer, and the client is told what broke.
      return {
        ...rest,
        'response.http.headers': forClient,
        'response.chat.responses.rendered': move(internalErrorEnvelope(error)),
        'response.http.status': 502,
        'response.chat.responses.streamedUsage': move(withVerdict(rest['response.chat.responses.streamedUsage'], true)),
      };
    }
  },
});

/** Whether the compaction resource says the turn behind it failed. `status` is not a key the
 *  compaction resource declares — it survives the spread from the turn the upstream actually
 *  ran, on either ending — and it is authoritative: a compaction that surfaced as failed
 *  belongs in the error column rather than masquerading as a success. */
const compactionFailed = (persisted: { readonly status?: string }): boolean => persisted.status === 'failed';

/** The accounting the epilogue settles from, with the verdict only the completed resource
 *  could give it. The edge is where a compaction resource comes into existence, so it is the
 *  one reader that can say whether the turn behind it succeeded. */
const withVerdict = (outcome: Promise<StreamOutcome> | null, failed: boolean): Promise<StreamOutcome> | null => {
  if (outcome === null || !failed) return outcome;
  return outcome.then(read => ({ ...read, failed: true }));
};

/**
 * The compaction wire. It asks the upstream's own `/responses` endpoint to compact, and hands
 * the envelope up as the events it expands into — the same currency a generate wire hands up,
 * which is what lets the stateful half above read either without knowing which ran.
 */
const callResponsesCompactUpstream = defineStage<
  R<'request.chat.responses' | 'route.attempt' | 'ingress.http.headers'>,
  Compacted<'response.chat.responses'> & R<'response.chat.responses.streamedUsage' | 'response.usage.billable' | 'response.http.headers'>,
  ChatServices
>({
  name: 'callResponsesCompactUpstream',
  return: {
    provides: [
      'response.chat.responses',
      RESPONSES_STREAMED_USAGE,
      'response.usage.billable',
      'response.http.headers',
    ],
  },
  execute: async (facts, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    // Attribution is set before the dial, so an attempt that never completes still names the
    // candidate it was made against rather than the one tried before it.
    use.gateway.attempt.telemetry = upstreamPerformanceContext(use.gateway, candidate, 'chat');

    const asked = facts['request.chat.responses'] as CanonicalResponsesPayload;
    const payload = { ...asked, model: candidate.model.id };
    if (candidate.rules !== undefined) applyRulesToUpstreamResponses(payload, candidate.rules);
    // Neither field belongs on this endpoint: `store` is a gateway-only snapshot hint the
    // compaction endpoint rejects, and `stream` describes how an answer would be delivered
    // where there is one body and no stream.
    const { model: _addressed, stream: _stream, store: _store, ...body } = payload;

    let result;
    try {
      result = await candidate.provider.instance.callResponses(
        providerModelOf(candidate),
        body,
        'compact',
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
        [RESPONSES_STREAMED_USAGE]: null,
        'response.usage.billable': [],
        'response.http.headers': [],
      });
    }

    const identity = telemetryModelIdentity(candidate, result.modelKey);
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
        [RESPONSES_STREAMED_USAGE]: null,
        // An upstream that was called and reported nothing, which is a different statement
        // from reporting zero.
        'response.usage.billable': [{ identity, quantities: {} }],
        'response.http.headers': [...result.response.headers],
      });
    }
    if (result.action !== 'compact') {
      throw new Error(`callResponsesCompactUpstream: ${facts['route.attempt'].upstreamId} answered a compaction dial with a ${result.action} turn`);
    }

    // This candidate answered, so it is the one a follow-up turn carrying our own state must
    // come back to.
    use.selectAffinity(candidate);

    const billable = [billedResponsesEntity(identity, billableUsageFromResponsesResult(result.result) ?? undefined)];
    return move({
      ...facts,
      'response.chat.responses': { kind: 'stream' as const, frames: syntheticEventsFromCompaction(result.result) },
      // A compaction states its own counts, so what it billed is known before the frames are
      // read. It travels as a reading still to come rather than as one already settled,
      // because the verdict that goes with it is the edge's to add.
      [RESPONSES_STREAMED_USAGE]: Promise.resolve({ billable, failed: false }),
      'response.usage.billable': billable,
      'response.http.headers': [],
    });
  },
});

/** The generate fork, as the simulation reaches it. A summarization is an ordinary turn, so
 *  it is dialled on the wires an ordinary turn is dialled on. */
const dialSummarizationWire = dialChatWire({
  source: 'request.chat.responses',
  needs: ['request.chat.responses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
  provides: ['response.chat.responses', RESPONSES_STREAMED_USAGE, 'response.usage.billable', 'response.http.headers'],
  pick: endpoints => responsesTarget.pick(endpoints),
  wire: responsesWireFor,
});

const compactionWire: ChatWire = compose('responsesCompactNative', [...responsesWireRules, callResponsesCompactUpstream]);
// The ending below picks this wire only for a candidate whose compactions are the shim's to
// simulate, so the ask is already answered: every turn that reaches it is one to summarize.
const simulationWire: ChatWire = compose('responsesCompactSimulated', [summarizeForCompaction(() => true), dialSummarizationWire]);

/**
 * Picks how this candidate's compaction is produced.
 *
 * An upstream whose own endpoint compacts is asked to, unless the operator asked for the
 * simulation instead — which is what the `responses-compact-shim` flag is: an opt-in for a
 * Responses upstream that would answer a compaction itself. Everything else is simulated,
 * structurally rather than by choice: no translation carries a compaction, so a Messages or
 * Chat Completions candidate has no compaction to dial.
 *
 * It is last, which is what earns it the right to name a target at all, and it holds no state
 * across candidates: failover re-running the suffix re-runs this stage.
 */
const dialResponsesCompaction = defineStage<
  R<'route.attempt'> & Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, unknown>,
  ChatServices
>({
  name: 'dialResponsesCompaction',
  into: {
    request: {
      needs: ['route.attempt', 'request.chat.responses', 'ingress.http.headers', 'ingress.chat.sourceProtocol'],
      consumes: [],
      provides: [],
    },
    // Nothing is read on the way back — a wire hands up this family's own keys and they ride
    // through — but this is where they enter the chain, so this is the stage that provides
    // them and the runner checks that the wire delivered.
    response: {
      needs: [],
      consumes: [],
      provides: [
        'response.chat.responses',
        RESPONSES_STREAMED_USAGE,
        'response.usage.billable',
        'response.http.headers',
      ],
    },
  },
  execute: async (facts, next, use) => {
    const candidate = use.resolveAttempt(facts['route.attempt']);
    const compacts = !simulatesCompaction(candidate, facts['route.attempt']);
    use.log.debug('compacting', { upstream: facts['route.attempt'].upstreamId, wire: compacts ? 'compact' : 'simulated' });
    return await next(facts, compacts ? compactionWire : simulationWire);
  },
});

export type ResponsesCompactEntry = R<
  'ingress.http.headers' | 'ingress.chat.sourceProtocol' | 'request.chat.responses' | 'serve.model'
>;

export type ResponsesCompactExit = R<
  'response.chat.responses.rendered' | 'response.chat.responses.streamedUsage'
  | 'response.http.status' | 'response.http.headers'
>;

export const responsesCompactPipeline = (payload: CanonicalResponsesPayload): Pipeline<ResponsesCompactEntry, ResponsesCompactExit> => {
  // One cell per run, written by the stage directly above the one that reads it — the same
  // hand-across the generate chain makes, for the same reason: the resolver takes its
  // narrowing at assembly, before any fact exists.
  let prepared = payload;
  return compose('responsesCompact', [
    emitResponsesCompaction,
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
    expandShimCompactions,
    disableReasoningOnForcedToolChoiceForResponses,
    stripPromptCacheKeyForResponses,
    vendorDeepSeekNormalizeForResponses,
    vendorQwenNormalizeForResponses,
    dialResponsesCompaction,
  ]);
};
