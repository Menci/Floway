import { inputErrorResult } from './errors.ts';
import { openaiChatCompletionsInterceptors } from './interceptors/index.ts';
import type { OpenAIChatCompletionsInvocation } from './interceptors/types.ts';
import { billableUsageFromOpenAIChatCompletionsEvent } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { geminiGenerateContentAttempt } from '../gemini-generate-content/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamOpenAIChatCompletions } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { upstreamStreamResultToExecuteResult } from '../shared/upstream-stream-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsPayloadEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import {
  routeOpenAIChatCompletionsViaAnthropicMessages,
  routeOpenAIChatCompletionsViaGeminiGenerateContent,
  routeOpenAIChatCompletionsViaOpenAIResponses,
  type TranslateInputError,
} from '@floway-dev/translate';
import { type ModelCandidate, type ExecuteResult } from '@floway-dev/upstream';

export const openaiChatCompletionsTarget = chatTargetPicker(['openaiChatCompletions', 'anthropicMessages', 'openaiResponses', 'geminiGenerateContent']);

export interface OpenAIChatCompletionsAttemptArgs {
  readonly payload: OpenAIChatCompletionsPayloadEx;
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
      const result = await dispatchOpenAIChatCompletions(invocation, ctx);
      return result.type === 'input-error' ? inputErrorResult(result, ctx.attempt.telemetry) : result;
    });
  },
};

const dispatchOpenAIChatCompletions = async (
  invocation: OpenAIChatCompletionsInvocation,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<OpenAIChatCompletionsStreamEvent>> | TranslateInputError> => {
  const { candidate, targetApi } = invocation;
  if (targetApi === 'openaiChatCompletions') {
    if (candidate.rules !== undefined) applyRulesToUpstreamOpenAIChatCompletions(invocation.payload, candidate.rules);
    const { model: _model, ...body } = invocation.payload;
    const upstreamResult = await candidate.upstream.instance.callOpenAIChatCompletions(
      candidate.model,
      body,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, invocation.headers),
    );
    return await upstreamStreamResultToExecuteResult(upstreamResult, candidate, 'openaiChatCompletions', ctx, billableUsageFromOpenAIChatCompletionsEvent);
  }
  const sidecarCodec = ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn);
  switch (targetApi) {
  case 'anthropicMessages':
    return await executeTranslation(
      invocation.payload,
      p => routeOpenAIChatCompletionsViaAnthropicMessages(p, {
        sidecarCodec,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      }),
      translated => anthropicMessagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'openaiResponses':
    return await executeTranslation(
      invocation.payload,
      p => routeOpenAIChatCompletionsViaOpenAIResponses(p, { sidecarCodec }),
      translated => openaiResponsesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'geminiGenerateContent':
    return await executeTranslation(
      invocation.payload,
      p => routeOpenAIChatCompletionsViaGeminiGenerateContent(p, { sidecarCodec }),
      ({ model: _model, ...body }) => geminiGenerateContentAttempt.generate({
        payload: body, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`openaiChatCompletionsAttempt.generate: unexpected targetApi '${exhaustive as string}'`);
  }
  }
};
