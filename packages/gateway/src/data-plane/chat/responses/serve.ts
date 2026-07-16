import { responsesAttempt } from './attempt.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import { prepareResponsesServePlan } from './serve-prep.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { CanonicalResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ResponsesServeGenerateArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface ResponsesServeCompactArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const responsesServe = {
  generate: async (args: ResponsesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const plan = await prepareResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    // Iterate the narrowed candidates: success (SSE stream opened) is the
    // final answer; per-candidate failures fall through so a transient
    // 5xx/429/network does not become the request's verdict when another
    // candidate can serve. The last failure surfaces verbatim on exhaustion.
    // Each attempt stamps its private prepared-payload clone with the
    // candidate's canonical model id.
    return await iterateCandidates(
      plan.candidates,
      'responsesServe.generate',
      ctx,
      'chat',
      candidate => responsesAttempt.generate({ payload: plan.prepared, ctx, candidate, headers }),
    );
  },

  compact: async (args: ResponsesServeCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, headers } = args;
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
    return await iterateCandidates(
      plan.candidates,
      'responsesServe.compact',
      ctx,
      'chat',
      candidate => responsesAttempt.invoke({ payload: plan.prepared, action: 'compact', ctx, candidate, headers }),
    );
  },
};
