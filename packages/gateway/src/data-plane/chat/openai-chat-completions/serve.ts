import { analyzeOpenAIChatCompletionsAffinity } from './affinity/ingress.ts';
import { openaiChatCompletionsAttempt, openaiChatCompletionsTarget } from './attempt.ts';
import { renderOpenAIChatCompletionsFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/resolution.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { selectAffinityCandidates } from '../shared/affinity/index.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface OpenAIChatCompletionsServeGenerateArgs {
  readonly payload: OpenAIChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const openaiChatCompletionsServe = {
  generate: async (args: OpenAIChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const affinity = await analyzeOpenAIChatCompletionsAffinity(payload, ctx.affinity.codec);
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      runtimeLocation: ctx.runtimeLocation,
    });
    const viable = enumerated.filter(c => openaiChatCompletionsTarget.canServe(c.model.endpoints));
    const selection = selectAffinityCandidates(viable, affinity);
    if ('kind' in selection) return renderOpenAIChatCompletionsFailure(selection);
    if (selection.candidates.length === 0) return renderOpenAIChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));

    // Try each affinity-selected candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim so the client still sees
    // real upstream telemetry rather than a synthetic envelope. Each attempt
    // stamps its private payload clone with the candidate's canonical model id
    // so aliases and prefixed ids resolve without mutating the caller payload.
    return await iterateCandidates(
      selection.candidates,
      'openaiChatCompletionsServe.generate',
      ctx,
      'chat',
      async candidate => {
        const result = await openaiChatCompletionsAttempt.generate({ payload: selection.payloadFor(candidate), ctx, candidate, headers });
        if (result.type === 'events') ctx.affinity.select(candidate);
        return result;
      },
    );
  },
};
