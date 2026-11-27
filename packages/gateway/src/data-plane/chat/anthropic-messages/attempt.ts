import { anthropicErrorEnvelopeBody, anthropicErrorResult, anthropicErrorTypeForStatus, inputErrorResult } from './errors.ts';
import { anthropicMessagesInterceptors, anthropicMessagesCountTokensInterceptors } from './interceptors/index.ts';
import type { AnthropicMessagesInvocation } from './interceptors/types.ts';
import { createAnthropicMessagesBillableUsageReader } from './usage.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { geminiGenerateContentAttempt } from '../gemini-generate-content/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamAnthropicMessages } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
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
  type PlainResult,
  decodeResponseBody,
  internalDebugErrorFields,
  plainResult,
  toInternalDebugError,
} from '@floway-dev/upstream';

// `/v1/messages` generate prefers a native Anthropic Messages target, then the
// translated OpenAI Responses path, then OpenAI Chat Completions, then Gemini GenerateContent.
export const anthropicMessagesGenerateTarget = chatTargetPicker(['anthropicMessages', 'openaiResponses', 'openaiChatCompletions', 'geminiGenerateContent']);

// `count_tokens` prefers a native Anthropic Messages target and otherwise
// translates to Gemini `:countTokens` and reshapes `{ totalTokens }` to `{ input_tokens }`.
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

  countTokens: async (args: AnthropicMessagesAttemptArgs): Promise<ApiErrorResult | PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders, anthropicBeta } = args;
    const payload = { ...sourcePayload, model: candidate.model.id };
    const headers = new Headers(sourceHeaders);
    headers.delete('anthropic-beta');
    // `pick` here is contractually total — serve filtered with
    // `anthropicMessagesCountTokensTarget.canServe`, so any other candidate is
    // a contract breach.
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
      const geminiResult = await geminiGenerateContentAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers,
      });
      return reshapeGeminiGenerateContentCountAsAnthropicMessages(geminiResult);
    });
  },
};

const extractGoogleRpcErrorMessage = (decoded: unknown, fallbackText: string): string => {
  if (decoded && typeof decoded === 'object' && 'error' in decoded) {
    const message = (decoded as { error?: { message?: unknown } }).error?.message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return fallbackText.trim() || 'Upstream token counting request failed.';
};

const reshapeGeminiGenerateContentCountAsAnthropicMessages = (
  geminiResult: ApiErrorResult | PlainResult,
): ApiErrorResult | PlainResult => {
  const { status, headers } = geminiResult.http;
  if (geminiResult.type === 'plain' && geminiResult.body === null && (status === 204 || status === 205 || status === 304)) {
    return geminiResult;
  }
  const text = decodeResponseBody(geminiResult.body);
  const http = { status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, headers) };
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch {}
  if (geminiResult.type === 'api-error' || status !== 200) {
    const body = anthropicErrorEnvelopeBody(
      anthropicErrorTypeForStatus(status),
      extractGoogleRpcErrorMessage(decoded, text),
    );
    return geminiResult.type === 'api-error'
      ? { ...geminiResult, http, body }
      : plainResult(http, body, geminiResult.upstreamId);
  }
  const totalTokens = decoded && typeof decoded === 'object' ? (decoded as { totalTokens?: unknown }).totalTokens : undefined;
  if (typeof totalTokens !== 'number' || !Number.isFinite(totalTokens)) {
    return anthropicErrorResult(
      502,
      'api_error',
      'Invalid upstream token counting response.',
      undefined,
      internalDebugErrorFields(toInternalDebugError(new Error('Invalid upstream token counting response.'))),
    );
  }
  return plainResult(
    http,
    new TextEncoder().encode(JSON.stringify({ input_tokens: totalTokens })),
    geminiResult.upstreamId,
  );
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
  if (targetApi === 'openaiResponses') {
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaOpenAIResponses(p, { sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
      translated => openaiResponsesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  if (targetApi === 'openaiChatCompletions') {
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaOpenAIChatCompletions(p, { sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn) }),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  if (targetApi === 'geminiGenerateContent') {
    return await executeTranslation(
      invocation.payload,
      p => routeAnthropicMessagesViaGeminiGenerateContent(p, {
        sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      }),
      ({ model: _model, ...body }) => geminiGenerateContentAttempt.generate({
        payload: body, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  throw new Error(`anthropicMessagesAttempt.generate: unexpected targetApi '${targetApi as string}'`);
};
