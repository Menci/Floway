import { openaiResponsesAttempt } from './attempt.ts';
import { openaiResponsesCreatedAt, wrapOpenAIResponsesStatefulOutput } from './client-output.ts';
import { completeOpenAIResponsesCompaction } from './compaction-resource.ts';
import type { OpenAIResponsesAttemptResult } from './interceptors/types.ts';
import { syntheticEventsFromCompaction } from './items/output.ts';
import { prepareOpenAIResponsesServePlan } from './serve-prep.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectOpenAIResponsesProtocolEventsToResult, type CanonicalOpenAIResponsesPayload, type ClientOpenAIResponsesCompaction, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { ExecuteResult } from '@floway-dev/provider';

interface OpenAIResponsesServeArgs {
  readonly payload: CanonicalOpenAIResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const openaiResponsesServe = {
  generate: async (args: OpenAIResponsesServeArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIResponsesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const plan = await prepareOpenAIResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    // Iterate the affinity-selected candidates: success (SSE stream opened) is the
    // final answer; per-candidate failures fall through so a transient
    // 5xx/429/network does not become the request's verdict when another
    // candidate can serve. The last failure surfaces verbatim on exhaustion.
    // Each attempt stamps its private prepared-payload clone with the
    // candidate's canonical model id.
    const result = await iterateCandidates(
      plan.candidates,
      'openaiResponsesServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await openaiResponsesAttempt.generate({
          payload: plan.affinitySelection.payloadFor(candidate),
          sourceState: {
            privatePayloads: plan.privatePayloads,
          },
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

  compact: async (args: OpenAIResponsesServeArgs): Promise<OpenAIResponsesAttemptResult<ClientOpenAIResponsesCompaction>> => {
    const { payload, ctx, headers } = args;
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present serve-prep expands it the same way generate does so
    // stored history is hydrated before candidate dispatch.
    //
    // For non-openai-responses targets the responses-compact-shim picks up the
    // request inside the interceptor chain, flips action='compact' to
    // 'generate', runs a SUMMARIZATION_PROMPT turn through translation, and
    // re-tags the result as compact on the way out.
    const plan = await prepareOpenAIResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    const result = await iterateCandidates(
      plan.candidates,
      'openaiResponsesServe.compact',
      ctx,
      'chat',
      async candidate => {
        const result = await openaiResponsesAttempt.invoke({
          payload: plan.affinitySelection.payloadFor(candidate),
          sourceState: {
            privatePayloads: plan.privatePayloads,
          },
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

    const stored = wrapOpenAIResponsesStatefulOutput(syntheticEventsFromCompaction(result.result), ctx);
    const persisted = await collectOpenAIResponsesProtocolEventsToResult(stored);
    return {
      ...result,
      result: completeOpenAIResponsesCompaction(persisted, openaiResponsesCreatedAt(ctx)),
    };
  },
};
