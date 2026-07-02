import { messagesAttempt, messagesGenerateTarget, messagesCountTokensTarget } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/registry.ts';
import { iterateCandidates } from '../../shared/iterate-candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

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
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => messagesGenerateTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: messagesViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');
    if (decision.candidates.length === 0) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');

    // Try each narrowed candidate in order. A successful attempt (SSE
    // stream opened) is the final answer; an api-error or internal-error
    // from one candidate falls through to the next so the gateway absorbs
    // transient 5xx/429/network failures. When the list is exhausted, the
    // most recent failure is forwarded verbatim. Normalize `payload.model`
    // to the candidate's real id so every attempt sees the canonical
    // resolved public id.
    return await iterateCandidates(
      decision.candidates,
      'messagesServe.generate',
      candidate => {
        payload.model = candidate.model.id;
        return messagesAttempt.generate({ payload, ctx, candidate, headers });
      },
    );
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => messagesCountTokensTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: messagesViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');
    if (decision.candidates.length === 0) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'countTokens');

    return await iterateCandidates(
      decision.candidates,
      'messagesServe.countTokens',
      candidate => {
        // Same normalization as generate above — every attempt sees
        // payload.model === candidate.model.id regardless of inbound form.
        payload.model = candidate.model.id;
        return messagesAttempt.countTokens({ payload, ctx, candidate, headers });
      },
    );
  },
};
