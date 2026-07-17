import { prepareGeminiAffinity } from './affinity/ingress.ts';
import { geminiAttempt, geminiCountTokensTarget, geminiGenerateTarget } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { routeCandidatesByAffinity } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface GeminiServeGenerateArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  // Per-request model id (Gemini carries it in the URL path, not the body),
  // resolved by the HTTP entry and threaded through here so candidate
  // enumeration and failure rendering all see the same value.
  readonly model: string;
  readonly headers: Headers;
}

export interface GeminiServeCountTokensArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  readonly model: string;
  readonly headers: Headers;
}

export const geminiServe = {
  generate: async (args: GeminiServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> => {
    const { payload, ctx, model, headers } = args;
    const prepared = await prepareGeminiAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => geminiGenerateTarget.canServe(c.model.endpoints));
    const decision = routeCandidatesByAffinity(viable, prepared.routingEvidence);
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'generate');
    if (decision.candidates.length === 0) return renderGeminiFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'generate');

    // Gemini carries the requested model in its URL, so affinity preparation
    // owns each candidate payload while dispatch uses the candidate's canonical model.
    return await iterateCandidates(
      decision.candidates,
      'geminiServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await geminiAttempt.generate({ payload: prepared.payloadForCandidate(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },

  countTokens: async (args: GeminiServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult> => {
    const { payload, ctx, model, headers } = args;
    const prepared = await prepareGeminiAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => geminiCountTokensTarget.canServe(c.model.endpoints));
    const decision = routeCandidatesByAffinity(viable, prepared.routingEvidence);
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'countTokens');
    if (decision.candidates.length === 0) return renderGeminiFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      decision.candidates,
      'geminiServe.countTokens',
      ctx,
      'chat',
      candidate => geminiAttempt.countTokens({ payload: prepared.payloadForCandidate(candidate), ctx, candidate, headers }),
    );
  },
};
