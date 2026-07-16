import { prepareChatCompletionsAffinity } from './affinity/ingress.ts';
import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { routeCandidatesByAffinity } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const prepared = await prepareChatCompletionsAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => chatCompletionsTarget.canServe(c.model.endpoints));
    const decision = routeCandidatesByAffinity(viable, prepared.routingEvidence);
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);
    if (decision.candidates.length === 0) return renderChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));

    // Try each narrowed candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim so the client still sees
    // real upstream telemetry rather than a synthetic envelope. Each attempt
    // stamps its private payload clone with the candidate's canonical model id
    // so aliases and prefixed ids resolve without mutating the caller payload.
    return await iterateCandidates(
      decision.candidates,
      'chatCompletionsServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await chatCompletionsAttempt.generate({ payload: prepared.payloadForCandidate(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },
};
