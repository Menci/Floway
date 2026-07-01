import { messagesInterceptors, messagesCountTokensInterceptors } from './interceptors/index.ts';
import type { MessagesInvocation } from './interceptors/types.ts';
import { requireRecordedDurationMs } from '../../shared/telemetry/performance.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { rewriteStoredResponsesItemsForCandidate } from '../responses/items/rewrite.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, chatTargetPicker } from '../shared/attempt-helpers.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { createUpstreamLatencyRecorder } from '../shared/upstream-telemetry.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ModelCandidate, ExecuteResult, PlainResult } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

// `/v1/messages` generate prefers a native Messages target, then the
// translated Responses path, then the translated Chat Completions path.
export const messagesGenerateTarget = chatTargetPicker(['messages', 'responses', 'chat-completions']);

// `count_tokens` has no translation path — only a native Messages target
// satisfies the operation.
export const messagesCountTokensTarget = chatTargetPicker(['messages']);

export interface MessagesAttemptGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export interface MessagesAttemptCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const messagesAttempt = {
  generate: async (args: MessagesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, candidate, headers } = args;
    const { store } = ctx;
    const targetApi = messagesGenerateTarget.pick(candidate.model.endpoints);
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) return rewritten.failure;
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, messagesInterceptors, async () => {
      if (targetApi === 'messages') {
        const { model: _model, ...body } = invocation.payload;
        const recorder = createUpstreamLatencyRecorder();
        const providerResult = await candidate.provider.instance.callMessages(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx, recorder);
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaResponses(p, { model: candidate.model.id }),
          translated => responsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaChatCompletions(p, { model: candidate.model.id }),
          translated => chatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`messagesAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: MessagesAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload, ctx, candidate, headers } = args;
    const { store } = ctx;
    // `pick` here is contractually total — serve filtered with
    // `messagesCountTokensTarget.canServe`, so a non-messages candidate is
    // a contract breach.
    const targetApi = messagesCountTokensTarget.pick(candidate.model.endpoints);
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) {
      // count_tokens has no streaming envelope; surface the rewrite-time
      // failure as a synthetic PlainResult carrying the same body.
      return { type: 'plain', status: rewritten.failure.status, headers: rewritten.failure.headers, body: rewritten.failure.body };
    }
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      targetApi,
      headers,
    };
    const recorder = createUpstreamLatencyRecorder();
    const response = await runInterceptors(invocation, ctx, messagesCountTokensInterceptors, async () => {
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.provider.instance.callMessagesCountTokens(
        providerModelOf(candidate),
        body,
        ctx.abortSignal,
        buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
      );
      return response;
    });
    // count_tokens is excluded from the `upstream_success` metric — that
    // metric only covers generation-shaped traffic — but the recorder
    // contract still has to fire so a provider that forgets to wrap fails
    // loud on the happy path.
    requireRecordedDurationMs(recorder, 'callMessagesCountTokens');
    return await plainResultFromResponse(response, candidate.provider.upstream);
  },
};

// Rewrites stored Responses item carriers (assistant thinking blocks whose
// signature packs a gateway-stored reasoning id) to the upstream-owned id
// the chosen candidate's wire requires. The failure path translates a
// missing-item lookup into a 400 invalid_request_error so a caller that
// referenced an item the gateway no longer has gets a useful error envelope
// rather than a generic 500.
const rewriteOrRenderMessagesFailure = async (
  payload: MessagesPayload,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<{ payload: MessagesPayload; failure?: undefined } | { payload?: undefined; failure: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> & { type: 'api-error' } }> => {
  try {
    const rewrittenMessages = await rewriteStoredResponsesItemsForCandidate(
      payload.messages as readonly MessagesMessage[],
      messagesViaResponsesItemsView,
      store,
      candidate,
    );
    return { payload: { ...payload, messages: rewrittenMessages as MessagesMessage[] } };
  } catch (error) {
    const failure = tryCatchChatServeFailure(error);
    if (failure === null) throw error;
    if (failure.kind !== 'item-not-found') throw error;
    return {
      failure: {
        type: 'api-error',
        source: 'gateway',
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: `Item with id '${failure.itemId}' not found.` },
        })),
      },
    };
  }
};
