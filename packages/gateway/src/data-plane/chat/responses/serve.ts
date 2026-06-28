import { responsesAttempt } from './attempt.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import { prepareResponsesServePlan } from './serve-prep.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ResponsesServeGenerateArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

export interface ResponsesServeCompactArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

export const responsesServe = {
  generate: async (args: ResponsesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const plan = await prepareResponsesServePlan({ payload, ctx, store });
    if (plan.kind === 'failure') return plan.result;
    return await responsesAttempt.generate({ payload: plan.prepared, ctx, store, candidate: plan.candidate, headers });
  },

  compact: async (args: ResponsesServeCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, store, headers } = args;
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present serve-prep expands it the same way generate does so
    // the upstream sees the same item_reference + current input shape.
    //
    // For non-responses targets the responses-compact-shim picks up the
    // request inside the interceptor chain, flips action='compact' to
    // 'generate', runs a SUMMARIZATION_PROMPT turn through translation, and
    // re-tags the result as compact on the way out.
    const plan = await prepareResponsesServePlan({ payload, ctx, store });
    if (plan.kind === 'failure') return plan.result;
    return await responsesAttempt.invoke({ payload: plan.prepared, action: 'compact', ctx, store, candidate: plan.candidate, headers });
  },
};
