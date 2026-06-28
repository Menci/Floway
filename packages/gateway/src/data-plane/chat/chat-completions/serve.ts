import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => chatCompletionsTarget.canServe(c.model.endpoints));
    const decision = await planChatCompletionsRouting({ payload, candidates: viable, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) return renderChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate, headers });
  },
};
