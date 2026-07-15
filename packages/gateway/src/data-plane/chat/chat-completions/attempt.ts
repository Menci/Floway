import { chatCompletionsInterceptors } from './interceptors/index.ts';
import type { ChatCompletionsInvocation } from './interceptors/types.ts';
import { applyRulesToUpstreamChatCompletions } from '../../model-aliases/apply-rules.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, chatTargetPicker } from '../../shared/telemetry/attempt-helpers.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ModelCandidate, type ExecuteResult, providerModelOf } from '@floway-dev/provider';
import { translateChatCompletionsViaMessages, translateChatCompletionsViaResponses } from '@floway-dev/translate';

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
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    const targetApi = chatCompletionsTarget.pick(candidate.model.endpoints);
    const invocation: ChatCompletionsInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, chatCompletionsInterceptors, async () => {
      if (targetApi === 'chat-completions') {
        if (candidate.rules !== undefined) applyRulesToUpstreamChatCompletions(invocation.payload, candidate.rules);
        const { model: _model, ...body } = invocation.payload;
        const providerResult = await candidate.provider.instance.callChatCompletions(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, 'chat-completions', ctx);
      }
      if (targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaMessages(p, {
            model: candidate.model.id,
            fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
            loadRemoteImage: createExternalImageLoader(ctx.abortSignal),
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
