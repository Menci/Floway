import { messagesInterceptors, messagesCountTokensInterceptors } from './interceptors/index.ts';
import type { MessagesInvocation } from './interceptors/types.ts';
import { applyRulesToUpstreamMessages } from '../../model-aliases/apply-rules.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, chatTargetPicker } from '../../shared/telemetry/attempt-helpers.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ModelCandidate, ExecuteResult, PlainResult } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';

// `/v1/messages` generate prefers a native Messages target, then the
// translated Responses path, then the translated Chat Completions path.
export const messagesGenerateTarget = chatTargetPicker(['messages', 'responses', 'chat-completions']);

// `count_tokens` has no translation path — only a native Messages target
// satisfies the operation.
export const messagesCountTokensTarget = chatTargetPicker(['messages']);

export interface MessagesAttemptArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const messagesAttempt = {
  generate: async (args: MessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    const targetApi = messagesGenerateTarget.pick(candidate.model.endpoints);
    const invocation: MessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, messagesInterceptors, async () => {
      if (targetApi === 'messages') {
        if (candidate.rules !== undefined) applyRulesToUpstreamMessages(invocation.payload, candidate.rules);
        const { model: _model, ...body } = invocation.payload;
        const providerResult = await candidate.provider.instance.callMessages(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx);
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

  countTokens: async (args: MessagesAttemptArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    // `pick` here is contractually total — serve filtered with
    // `messagesCountTokensTarget.canServe`, so a non-messages candidate is
    // a contract breach.
    const targetApi = messagesCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: MessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    const response = await runInterceptors(invocation, ctx, messagesCountTokensInterceptors, async () => {
      if (candidate.rules !== undefined) applyRulesToUpstreamMessages(invocation.payload, candidate.rules);
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.provider.instance.callMessagesCountTokens(
        providerModelOf(candidate),
        body,
        ctx.abortSignal,
        buildUpstreamCallOptions(candidate, ctx, invocation.headers),
      );
      return response;
    });
    return await plainResultFromResponse(response, candidate.provider.upstream);
  },
};
