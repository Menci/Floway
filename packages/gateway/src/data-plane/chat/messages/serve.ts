import { prepareMessagesAffinity } from './affinity/ingress.ts';
import { messagesAttempt, messagesGenerateTarget, messagesCountTokensTarget } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { routeCandidatesByAffinity } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface MessagesServeGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface MessagesServeCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const prepared = await prepareMessagesAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => messagesGenerateTarget.canServe(c.model.endpoints));
    const decision = routeCandidatesByAffinity(viable, prepared.routingEvidence);
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');
    if (decision.candidates.length === 0) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');

    // Try each narrowed candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim. Each attempt stamps its
    // private payload clone with the candidate's canonical model id.
    return await iterateCandidates(
      decision.candidates,
      'messagesServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await messagesAttempt.generate({ payload: prepared.payloadForCandidate(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, headers } = args;
    const prepared = await prepareMessagesAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => messagesCountTokensTarget.canServe(c.model.endpoints));
    const decision = routeCandidatesByAffinity(viable, prepared.routingEvidence);
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');
    if (decision.candidates.length === 0) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      decision.candidates,
      'messagesServe.countTokens',
      ctx,
      'chat',
      candidate => messagesAttempt.countTokens({ payload: prepared.payloadForCandidate(candidate), ctx, candidate, headers }),
    );
  },
};
