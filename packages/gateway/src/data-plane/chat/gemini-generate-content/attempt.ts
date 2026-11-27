import { klona } from 'klona/json';

import { inputErrorResult, geminiGenerateContentInternalErrorPayload, gatewayErrorStatus, normalizeGeminiGenerateContentFailure } from './errors.ts';
import { geminiGenerateContentCountTokensInterceptors, geminiGenerateContentInterceptors } from './interceptors/index.ts';
import { buildUpstreamCallOptions } from '../../shared/upstream-call-options.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import { applyRulesToUpstreamGeminiGenerateContent } from '../shared/alias-rules.ts';
import { captureFromDump, executeTranslation } from '../shared/execute-translation.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { SidecarDomain } from '../shared/sidecar-codec.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { upstreamStreamResultToExecuteResult } from '../shared/upstream-stream-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { billableUsageFromGeminiGenerateContentEvent, type GeminiGenerateContentPayload, type GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { routeGeminiGenerateContentViaAnthropicMessages, routeGeminiGenerateContentViaOpenAIChatCompletions, routeGeminiGenerateContentViaOpenAIResponses, type TranslateInputError } from '@floway-dev/translate';
import { type ModelCandidate, decodeResponseBody, plainResult, toInternalDebugError, type ApiErrorResult, type ExecuteResult, type GeminiGenerateContentInvocation, type PlainResult } from '@floway-dev/upstream';

// A candidate that speaks Gemini's native wire receives the client's payload
// as shaped, so the source must be tried first. Everything else translates:
// generate prefers OpenAI Chat Completions, then Anthropic Messages, then
// OpenAI Responses, and countTokens has no translation path beyond native
// Anthropic Messages count_tokens.
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
    const payload = klona(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentGenerateTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    const result = await runInterceptors(invocation, ctx, geminiGenerateContentInterceptors, async () => {
      const result = await dispatchGeminiGenerateContent(invocation, ctx);
      return result.type === 'input-error' ? inputErrorResult(result, ctx.attempt.telemetry) : result;
    });
    return result.type === 'events' ? result : normalizeGeminiGenerateContentFailure(result);
  },

  countTokens: async (args: GeminiGenerateContentAttemptCountTokensArgs): Promise<ApiErrorResult | PlainResult> => {
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
      const anthropicMessagesResult = await anthropicMessagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      });
      return reshapeAnthropicMessagesCountAsGeminiGenerateContent(anthropicMessagesResult, trip.error);
    });
  },
};

// Reshape the Anthropic Messages count_tokens body into the Gemini generateContent `{ totalTokens }`
// envelope. The upstream body shape is provider-specific: Anthropic emits
// `{ input_tokens }`, Copilot's translated count emits `{ total_tokens }`;
// either is accepted. A missing or non-numeric figure is surfaced as a
// 502 Google-RPC error so the caller sees a typed Gemini generateContent failure rather
// than a passthrough of the upstream shape.
const reshapeAnthropicMessagesCountAsGeminiGenerateContent = (
  anthropicMessagesResult: PlainResult,
  translateError: (status: number, headers: Headers, body: Uint8Array) => { readonly status: number; readonly headers: Headers; readonly body: unknown } | undefined,
): PlainResult => {
  const { status, headers } = anthropicMessagesResult.http;
  if (anthropicMessagesResult.body === null && (status === 204 || status === 205 || status === 304)) {
    return anthropicMessagesResult;
  }
  const text = decodeResponseBody(anthropicMessagesResult.body);
  const http = { status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, headers) };
  if (status !== 200) {
    const rawBody = anthropicMessagesResult.body instanceof Uint8Array
      ? anthropicMessagesResult.body
      : new TextEncoder().encode(text);
    const translated = translateError(status, headers, rawBody);
    if (translated !== undefined) {
      return plainResult(
        { status: translated.status, headers: mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, translated.headers) },
        new TextEncoder().encode(JSON.stringify(translated.body)),
        anthropicMessagesResult.upstreamId,
      );
    }
    // Empty or unrecognized upstream bodies fall back to a Google-RPC envelope.
    return plainResult(
      http,
      new TextEncoder().encode(JSON.stringify({
        error: { code: status, message: text || 'Upstream token counting request failed.', status: gatewayErrorStatus(status) },
      })),
      anthropicMessagesResult.upstreamId,
    );
  }
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch {}
  const upstreamTokenCounts = decoded && typeof decoded === 'object'
    ? decoded as { input_tokens?: unknown; total_tokens?: unknown }
    : {};
  const totalTokens = typeof upstreamTokenCounts.input_tokens === 'number'
    ? upstreamTokenCounts.input_tokens
    : typeof upstreamTokenCounts.total_tokens === 'number'
      ? upstreamTokenCounts.total_tokens
      : null;
  if (totalTokens === null) {
    return geminiGenerateContentInternalPlainResult(502, new Error('Invalid upstream token counting response.'));
  }
  return plainResult(
    http,
    new TextEncoder().encode(JSON.stringify({ totalTokens })),
    anthropicMessagesResult.upstreamId,
  );
};

const geminiGenerateContentInternalPlainResult = (status: number, error: Error): PlainResult => plainResult(
  { status, headers: new Headers({ 'content-type': 'application/json' }) },
  new TextEncoder().encode(JSON.stringify(geminiGenerateContentInternalErrorPayload(status, toInternalDebugError(error)))),
);

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
  if (targetApi === 'anthropicMessages') {
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaAnthropicMessages(p, transCtx),
      translated => anthropicMessagesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  if (targetApi === 'openaiResponses') {
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaOpenAIResponses(p, transCtx),
      translated => openaiResponsesAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  if (targetApi === 'openaiChatCompletions') {
    return await executeTranslation(
      request,
      p => routeGeminiGenerateContentViaOpenAIChatCompletions(p, transCtx),
      translated => openaiChatCompletionsAttempt.generate({
        payload: translated, ctx, candidate, headers: invocation.headers,
      }),
      captureFromDump(ctx.dump, targetApi),
    );
  }
  throw new Error(`geminiGenerateContentAttempt.generate: unexpected targetApi '${targetApi as string}'`);
};
