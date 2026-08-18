import { openaiChatCompletionsInterceptors } from './interceptors/index.ts';
import type { OpenAIChatCompletionsInvocation } from './interceptors/types.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { createExternalImageLoader } from '../shared/external-image-loader.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayload, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { type ModelCandidate, type ExecuteResult, providerModelOf } from '@floway-dev/provider';
import { translateOpenAIChatCompletionsViaAnthropicMessages, translateOpenAIChatCompletionsViaOpenAIResponses } from '@floway-dev/translate';

// `/v1/chat/completions` generate prefers a native OpenAI Chat Completions target,
// then the translated Anthropic Messages path, then the translated OpenAI Responses path.
export const openaiChatCompletionsTarget = chatTargetPicker(['openai-chat-completions', 'messages', 'responses']);

export interface OpenAIChatCompletionsAttemptArgs {
  readonly payload: OpenAIChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const openaiChatCompletionsAttempt = {
  generate: async (args: OpenAIChatCompletionsAttemptArgs): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    const targetApi = openaiChatCompletionsTarget.pick(candidate.model.endpoints);
    const invocation: OpenAIChatCompletionsInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, openaiChatCompletionsInterceptors, async () => {
      if (targetApi === 'openai-chat-completions') {
        if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIChatCompletions(invocation.payload, candidate.rules);
        const { model: _model, ...body } = invocation.payload;
        const providerResult = await candidate.provider.instance.callOpenAIChatCompletions(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, 'openai-chat-completions', ctx, billableUsageFromOpenAIChatCompletionsEvent);
      }
      if (targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateOpenAIChatCompletionsViaAnthropicMessages(p, {
            model: candidate.model.id,
            fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
            loadRemoteImage: createExternalImageLoader(ctx.abortSignal),
          }),
          translated => anthropicMessagesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
          }),
        );
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateOpenAIChatCompletionsViaOpenAIResponses(p, { model: candidate.model.id }),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`openaiChatCompletionsAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },
};
