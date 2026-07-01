import { chatCompletionsInterceptors } from './interceptors/index.ts';
import type { ChatCompletionsInvocation } from './interceptors/types.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { rewriteStoredResponsesItemsForCandidate } from '../responses/items/rewrite.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, chatTargetPicker } from '../shared/attempt-helpers.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { createUpstreamLatencyRecorder } from '../shared/upstream-telemetry.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsMessage, ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ModelCandidate, type ExecuteResult, providerModelOf } from '@floway-dev/provider';
import { translateChatCompletionsViaMessages, translateChatCompletionsViaResponses } from '@floway-dev/translate';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

// `/v1/chat/completions` generate prefers a native Chat Completions target,
// then the translated Messages path, then the translated Responses path.
export const chatCompletionsTarget = chatTargetPicker(['chat-completions', 'messages', 'responses']);

export interface ChatCompletionsAttemptArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, candidate, headers } = args;
    const targetApi = chatCompletionsTarget.pick(candidate.model.endpoints);
    const rewritten = await rewriteOrRenderChatCompletionsFailure(payload, ctx.store, candidate);
    if (rewritten.failure) return rewritten.failure;
    const invocation: ChatCompletionsInvocation = {
      payload: rewritten.payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, chatCompletionsInterceptors, async () => {
      if (targetApi === 'chat-completions') {
        return await callChatCompletionsAsExecuteResult(invocation.payload, ctx, candidate, invocation.headers);
      }
      if (targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaMessages(p, {
            model: candidate.model.id,
            fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
          }),
          translated => messagesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaResponses(p, { model: candidate.model.id }),
          translated => responsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`chatCompletionsAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },
};

// Chat Completions carries stored Responses reasoning ids on
// `assistant.reasoning_items`; the translate-package view exposes them as
// Responses items so the shared rewrite pass works here too.
const rewriteOrRenderChatCompletionsFailure = async (
  payload: ChatCompletionsPayload,
  store: StatefulResponsesStore,
  candidate: ModelCandidate,
): Promise<{ payload: ChatCompletionsPayload; failure?: undefined } | { payload?: undefined; failure: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> & { type: 'api-error' } }> => {
  try {
    const rewrittenMessages = await rewriteStoredResponsesItemsForCandidate(
      payload.messages as readonly ChatCompletionsMessage[],
      chatCompletionsViaResponsesItemsView,
      store,
      candidate,
    );
    return { payload: { ...payload, messages: rewrittenMessages as ChatCompletionsMessage[] } };
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
          error: { type: 'invalid_request_error', message: `Item with id '${failure.itemId}' not found.` },
        })),
      },
    };
  }
};

const callChatCompletionsAsExecuteResult = async (
  payload: ChatCompletionsPayload,
  ctx: ChatGatewayCtx,
  candidate: ModelCandidate,
  headers: Headers,
): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  const { model: _model, ...body } = payload;
  const recorder = createUpstreamLatencyRecorder();
  const providerResult = await candidate.provider.instance.callChatCompletions(
    providerModelOf(candidate),
    body,
    ctx.abortSignal,
    buildUpstreamCallOptions(candidate, ctx, recorder.record, headers),
  );
  return await providerStreamResultToExecuteResult(providerResult, candidate, 'chat-completions', ctx, recorder);
};
