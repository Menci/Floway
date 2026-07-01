import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => chatCompletionsTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: chatCompletionsViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);
    if (decision.candidates.length === 0) return renderChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));

    // Try each narrowed candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim so the client still sees
    // real upstream telemetry rather than a synthetic envelope. Normalize
    // `payload.model` to the candidate's real id — inbound may be an alias
    // name, a prefix-addressable variant, or a dated-suffix id, but every
    // attempt sees the canonical resolved public id.
    return await iterateCandidates(
      decision.candidates,
      'chatCompletionsServe.generate',
      candidate => {
        payload.model = candidate.model.id;
        return chatCompletionsAttempt.generate({ payload, ctx, candidate, headers });
      },
    );
  },
};
