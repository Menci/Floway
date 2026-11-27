import { klona } from 'klona/json';

import { inputErrorResult, geminiGenerateContentRpcErrorPayload } from './errors.ts';
import { geminiGenerateContentCountTokensInterceptors, geminiGenerateContentInterceptors } from './interceptors/index.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { reshapeTranslatedCountTokens } from '../shared/translated-count-tokens.ts';
import { upstreamStreamResultToExecuteResult } from '../shared/upstream-stream-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentEvent, type GeminiGenerateContentPayload, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIResponses, type TranslateInputError } from '@floway-dev/translate';
import { type ModelCandidate, type ApiErrorResult, type ExecuteResult, type GeminiGenerateContentInvocation, type InternalErrorResult, type PlainResult } from '@floway-dev/upstream';

export const geminiGenerateContentGenerateTarget = chatTargetPicker(['geminiGenerateContent', 'openaiChatCompletions', 'anthropicMessages', 'openaiResponses']);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['geminiGenerateContent', 'anthropicMessages']);

export interface GeminiGenerateContentAttemptGenerateArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export interface GeminiGenerateContentAttemptCountTokensArgs {
  readonly payload: GeminiGenerateContentPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const geminiGenerateContentAttempt = {
  generate: async (args: GeminiGenerateContentAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>>> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    // Translated payloads carry `JSON.rawJSON` tokens (such as `1.0` in tool arguments) that `structuredClone` rejects.
    const payload = klona(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentGenerateTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentInterceptors, async () => {
      const result = await dispatchGeminiGenerateContent(invocation, ctx);
      return result.type === 'input-error' ? inputErrorResult(result, ctx.attempt.telemetry) : result;
    });
  },

  countTokens: async (args: GeminiGenerateContentAttemptCountTokensArgs): Promise<ApiErrorResult | InternalErrorResult | PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = klona(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentCountTokensInterceptors, async () => {
      if (targetApi === 'geminiGenerateContent') {
        if (candidate.rules !== undefined) applyRulesToUpstreamGeminiGenerateContent(invocation.payload, candidate.rules);
        const { http: response } = await candidate.upstream.instance.callGeminiGenerateContentCountTokens(
          candidate.model,
          invocation.payload,
          ctx.abortSignal,
          buildUpstreamCallOptions(candidate, ctx, invocation.headers),
        );
        return await plainResultFromResponse(response, candidate.upstream.upstreamId);
      }
      // Without a native target the count is synthesized from Anthropic
      // Messages: the payload the shared interceptor chain already cleaned is
      // translated, counted upstream, and the reply reshaped into Gemini's
      // `{ totalTokens }` envelope.
      const transCtx = {
        sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      // The model travels in the URL rather than the body, so the request this
      // trip reads is the resolved model folded into the invocation payload.
      const trip = await routeGeminiGenerateContentViaAnthropicMessages({ ...invocation.payload, model: candidate.model.id }, transCtx);
      if (trip.type === 'input-error') return inputErrorResult(trip, ctx.attempt.telemetry);
      const { stream: _stream, ...target } = trip.target;
      const capture = captureFromDump(ctx.dump, targetApi);
      const anthropicMessagesResult = await anthropicMessagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      });
      return reshapeTranslatedCountTokens(anthropicMessagesResult, {
        translateError: trip.error,
        fallbackErrorBody: (status, message) => new TextEncoder().encode(JSON.stringify(geminiGenerateContentRpcErrorPayload(status, message))),
        // Anthropic emits `{ input_tokens }`; Copilot's translated count emits `{ total_tokens }`.
        extractCount: decoded => (typeof decoded.input_tokens === 'number' ? decoded.input_tokens : decoded.total_tokens),
        encodeCount: totalTokens => ({ totalTokens }),
        performance: ctx.attempt.telemetry,
        capture,
      });
    });
  },
};

const dispatchGeminiGenerateContent = async (
  invocation: GeminiGenerateContentInvocation,
  ctx: ChatGatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<GeminiGenerateContentStreamEvent>> | TranslateInputError> => {
  const { candidate, targetApi } = invocation;
  if (targetApi === 'geminiGenerateContent') {
    if (candidate.rules !== undefined) applyRulesToUpstreamGeminiGenerateContent(invocation.payload, candidate.rules);
    // The upstream reads the model from the URL, so the payload crosses the
    // provider boundary exactly as the client shaped it.
    const upstreamResult = await candidate.upstream.instance.callGeminiGenerateContent(
      candidate.model,
      invocation.payload,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, invocation.headers),
    );
    return await upstreamStreamResultToExecuteResult(upstreamResult, candidate, targetApi, ctx, billableUsageFromGeminiGenerateContentEvent);
  }
  // The model comes from the URL and is folded into the translation request.
  const request = { ...invocation.payload, model: candidate.model.id };
  const transCtx = {
    sidecarCodec: ctx.sidecarCodecFactory.codecFor(SidecarDomain.TranslatedAssistantTurn),
    fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
  };
  switch (targetApi) {
  case 'anthropicMessages':
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaAnthropicMessages(p, transCtx),
      translated => anthropicMessagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'openaiResponses':
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaOpenAIResponses(p, transCtx),
      translated => openaiResponsesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  case 'openaiChatCompletions':
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaOpenAIChatCompletions(p, transCtx),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  default: {
    const exhaustive: never = targetApi;
    throw new Error(`geminiGenerateContentAttempt.generate: unexpected targetApi '${exhaustive as string}'`);
  }
  }
};
