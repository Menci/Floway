import { anthropicMessagesInterceptors, anthropicMessagesCountTokensInterceptors } from './interceptors/index.ts';
import type { AnthropicMessagesInvocation } from './interceptors/types.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { providerStreamResultToExecuteResult } from '../shared/provider-stream-result.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ModelCandidate, ExecuteResult, AnthropicMessagesUpstreamCallOptions, PlainResult } from '@floway-dev/provider';
import { providerModelOf } from '@floway-dev/provider';
import { translateAnthropicMessagesViaOpenAIChatCompletions, translateAnthropicMessagesViaOpenAIResponses } from '@floway-dev/translate';

// `/v1/messages` generate prefers a native Anthropic Messages target, then the
// translated OpenAI Responses path, then the translated OpenAI Chat Completions path.
export const anthropicMessagesGenerateTarget = chatTargetPicker(['messages', 'responses', 'openai-chat-completions']);

// `count_tokens` has no translation path — only a native Anthropic Messages target
// satisfies the operation.
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['messages']);

export interface AnthropicMessagesAttemptArgs {
  readonly payload: AnthropicMessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
  readonly anthropicBeta: readonly string[];
}

const buildAnthropicMessagesUpstreamCallOptions = (
  candidate: ModelCandidate,
  ctx: ChatGatewayCtx,
  headers: Headers,
  anthropicBeta: readonly string[],
): AnthropicMessagesUpstreamCallOptions => ({
  ...buildUpstreamCallOptions(candidate, ctx, headers),
  anthropicBeta,
});

export const anthropicMessagesAttempt = {
  generate: async (args: AnthropicMessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    const targetApi = anthropicMessagesGenerateTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    return await runInterceptors(invocation, ctx, anthropicMessagesInterceptors, async () => {
      if (targetApi === 'messages') {
        if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
        const { model: _model, ...body } = invocation.payload;
        const providerResult = await candidate.provider.instance.callAnthropicMessages(
          providerModelOf(candidate),
          body,
          ctx.abortSignal,
          buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, anthropicBeta),
        );
        return await providerStreamResultToExecuteResult(providerResult, candidate, targetApi, ctx, createAnthropicMessagesBillableUsageReader());
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateAnthropicMessagesViaOpenAIResponses(p, { model: candidate.model.id }),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'openai-chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateAnthropicMessagesViaOpenAIChatCompletions(p, { model: candidate.model.id }),
          translated => openaiChatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`anthropicMessagesAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: AnthropicMessagesAttemptArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    // `pick` here is contractually total — serve filtered with
    // `anthropicMessagesCountTokensTarget.canServe`, so a non-anthropic-messages candidate is
    // a contract breach.
    const targetApi = anthropicMessagesCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
    };
    const response = await runInterceptors(invocation, ctx, anthropicMessagesCountTokensInterceptors, async () => {
      if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.provider.instance.callAnthropicMessagesCountTokens(
        providerModelOf(candidate),
        body,
        ctx.abortSignal,
        buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, anthropicBeta),
      );
      return response;
    });
    return await plainResultFromResponse(response, candidate.provider.upstreamId);
  },
};
