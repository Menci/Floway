import { wrapResponsesAffinityEgress } from './affinity/egress.ts';
import { responsesAttempt } from './attempt.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import { createStoredResponseId } from './items/format.ts';
import { syntheticEventsFromResult, wrapResponsesOutputForStorage } from './items/output.ts';
import { prepareResponsesServePlan } from './serve-prep.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult, type CanonicalResponsesPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

interface ResponsesServeArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const responsesServe = {
  generate: async (args: ResponsesServeArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const plan = await prepareResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    // Iterate the narrowed candidates: success (SSE stream opened) is the
    // final answer; per-candidate failures fall through so a transient
    // 5xx/429/network does not become the request's verdict when another
    // candidate can serve. The last failure surfaces verbatim on exhaustion.
    // Each attempt stamps its private prepared-payload clone with the
    // candidate's canonical model id.
    const result = await iterateCandidates(
      plan.candidates,
      'responsesServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await responsesAttempt.generate({
          sourcePreparation: { affinity: plan.affinity, privatePayloads: plan.privatePayloads },
          ctx,
          candidate,
          headers,
        });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
    return result;
  },

  compact: async (args: ResponsesServeArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, headers } = args;
    const store = ctx.store;
    if (store === undefined) throw new Error('Native Responses compact requires a state store');
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present serve-prep expands it the same way generate does so
    // the candidate rewrite can restore the stored history before dispatch.
    //
    // For non-responses targets the responses-compact-shim picks up the
    // request inside the interceptor chain, flips action='compact' to
    // 'generate', runs a SUMMARIZATION_PROMPT turn through translation, and
    // re-tags the result as compact on the way out.
    const plan = await prepareResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    const result = await iterateCandidates(
      plan.candidates,
      'responsesServe.compact',
      ctx,
      'chat',
      async candidate => {
        const result = await responsesAttempt.invoke({
          sourcePreparation: { affinity: plan.affinity, privatePayloads: plan.privatePayloads },
          action: 'compact',
          ctx,
          candidate,
          headers,
        });
        if (result.type === 'result') ctx.affinity.select(candidate);
        return result;
      },
    );
    if (result.type !== 'result') return result;

    const withAffinity = wrapResponsesAffinityEgress(syntheticEventsFromResult(result.result), {
      codec: ctx.affinity.codec,
      affinity: ctx.affinity.selectedTarget(),
    });
    if (!store.storesState) {
      const clientResult = await collectResponsesProtocolEventsToResult(withAffinity);
      return { ...result, result: clientResult, usage: tokenUsageFromResponsesResult(clientResult) };
    }
    const stored = wrapResponsesOutputForStorage(withAffinity, {
      store,
      attemptState: ctx.responsesAttemptState,
      responseId: createStoredResponseId(),
    });
    const clientResult = await collectResponsesProtocolEventsToResult(stored);
    return {
      ...result,
      result: clientResult,
      usage: tokenUsageFromResponsesResult(clientResult),
    };
  },
};
