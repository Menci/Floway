import { geminiAttempt, geminiCountTokensTarget, geminiGenerateTarget } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

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
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => geminiGenerateTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.contents ?? [],
      view: geminiViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'generate');
    if (decision.candidates.length === 0) return renderGeminiFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'generate');

    // Try each narrowed candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim so the client still sees
    // real upstream telemetry rather than a synthetic envelope. The
    // Gemini URL-path model id is already in `model`; downstream dispatch
    // keys off `candidate.model.id`, so no payload rewrite is needed here
    // even for alias-origin candidates.
    return await iterateCandidates(
      decision.candidates,
      'geminiServe.generate',
      candidate => geminiAttempt.generate({ payload, ctx, candidate, headers }),
    );
  },

  countTokens: async (args: GeminiServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult> => {
    const { payload, ctx, model, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => geminiCountTokensTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.contents ?? [],
      view: geminiViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'countTokens');
    if (decision.candidates.length === 0) return renderGeminiFailure(noViableCandidateFailure(sawModel, model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      decision.candidates,
      'geminiServe.countTokens',
      candidate => geminiAttempt.countTokens({ payload, ctx, candidate, headers }),
    );
  },
};
