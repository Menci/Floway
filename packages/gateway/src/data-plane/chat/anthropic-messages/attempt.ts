import { inputErrorResult } from './errors.ts';
import { anthropicMessagesInterceptors, anthropicMessagesCountTokensInterceptors } from './interceptors/index.ts';
import type { AnthropicMessagesInvocation } from './interceptors/types.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { geminiGenerateContentAttempt } from '../gemini-generate-content/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { reshapeTranslatedCountTokens } from '../shared/translated-count-tokens.ts';
import { upstreamStreamResultToExecuteResult } from '../shared/upstream-stream-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import {
  routeAnthropicMessagesViaGeminiGenerateContent,
  routeAnthropicMessagesViaOpenAIChatCompletions,
  routeAnthropicMessagesViaOpenAIResponses,
  type TranslateInputError,
} from '@floway-dev/translate';
import {
  type ModelCandidate,
  type ApiErrorResult,
  type ExecuteResult,
  type AnthropicMessagesUpstreamCallOptions,
  type InternalErrorResult,
  type PlainResult,
} from '@floway-dev/upstream';

export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions', 'geminiGenerateContent']);
export const anthropicMessagesCountTokensTarget = chatTargetPicker(['anthropicMessages', 'geminiGenerateContent']);

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
  generate: async (args: AnthropicMessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> => {
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
      anthropicBeta,
    };
    return await runInterceptors(invocation, ctx, anthropicMessagesInterceptors, async () => {
      const result = await dispatchAnthropicMessages(invocation, ctx);
      return result.type === 'input-error' ? inputErrorResult(result, ctx.attempt.telemetry) : result;
    });
  },

  countTokens: async (args: AnthropicMessagesAttemptArgs): Promise<ApiErrorResult | InternalErrorResult | PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    const targetApi = anthropicMessagesCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: AnthropicMessagesInvocation = {
      payload,
      candidate,
      targetApi,
      headers,
      anthropicBeta,
    };
    return await runInterceptors(invocation, ctx, anthropicMessagesCountTokensInterceptors, async () => {
      if (targetApi === 'anthropicMessages') {
        if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
        const { model: _model, ...body } = invocation.payload;
        const { http: response } = await candidate.upstream.instance.callAnthropicMessagesCountTokens(
          candidate.model,
          body,
          ctx.abortSignal,
          buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, invocation.anthropicBeta),
        );
        return await plainResultFromResponse(response, candidate.upstream.upstreamId);
      }
      const trip = await routeAnthropicMessagesViaGeminiGenerateContent(
        { ...invocation.payload, stream: true },
        { sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) },
      );
      if (trip.type === 'input-error') return inputErrorResult(trip, ctx.attempt.telemetry);
      const { model: _model, ...target } = trip.target;
      const capture = captureFromDump(ctx.dump, targetApi);
      const generateContentResult = await geminiGenerateContentAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers,
      });
      return reshapeTranslatedCountTokens(generateContentResult, {
        translateError: trip.error,
        extractCount: decoded => decoded.totalTokens,
        encodeCount: input_tokens => ({ input_tokens }),
        performance: ctx.attempt.telemetry,
        capture,
      });
    });
  },
};

const dispatchAnthropicMessages = async (
  invocation: AnthropicMessagesInvocation,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>> | TranslateInputError> => {
  const { candidate, targetApi } = invocation;
  if (targetApi === 'anthropicMessages') {
    if (candidate.rules !== undefined) applyRulesToUpstreamAnthropicMessages(invocation.payload, candidate.rules);
    const { model: _model, ...body } = invocation.payload;
    const upstreamResult = await candidate.upstream.instance.callAnthropicMessages(
      candidate.model,
      body,
      ctx.abortSignal,
      buildAnthropicMessagesUpstreamCallOptions(candidate, ctx, invocation.headers, invocation.anthropicBeta),
    );
    return await upstreamStreamResultToExecuteResult(upstreamResult, candidate, targetApi, ctx, createAnthropicMessagesBillableUsageReader());
  }
  const sidecarCodec = ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn);
  switch (targetApi) {
  case 'openaiResponses':
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaOpenAIResponses(p, { sidecarCodec }),
      translated => openaiResponsesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'openaiChatCompletions':
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaOpenAIChatCompletions(p, { sidecarCodec }),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'geminiGenerateContent':
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaGeminiGenerateContent(p, { sidecarCodec }),
      ({ model: _model, ...body }) => geminiGenerateContentAttempt.generate({
        payload: body, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`anthropicMessagesAttempt.generate: unexpected targetApi '${exhaustive as string}'`);
  }
  }
};
