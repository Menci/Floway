import { geminiGenerateContentStatusForHttpStatus } from './errors.ts';
import { geminiGenerateContentCountTokensInterceptors, geminiGenerateContentInterceptors } from './interceptors/index.ts';
import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import { openaiChatCompletionsAttempt } from '../openai-chat-completions/attempt.ts';
import { anthropicMessagesAttempt } from '../anthropic-messages/attempt.ts';
import { openaiResponsesAttempt } from '../openai-responses/attempt.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentPayload, GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { type ModelCandidate, plainResult, type ExecuteResult, type GeminiGenerateContentInvocation, type PlainResult } from '@floway-dev/provider';
import { translateGeminiGenerateContentViaOpenAIChatCompletions, translateGeminiGenerateContentViaAnthropicMessages, translateGeminiGenerateContentViaOpenAIResponses } from '@floway-dev/translate';

// Gemini has no native upstream target in the provider API; prefer Chat
// Completions, then Anthropic Messages, then OpenAI Responses for generate. countTokens has
// no translation path beyond native Anthropic Messages count_tokens.
export const geminiGenerateContentGenerateTarget = chatTargetPicker(['openai-chat-completions', 'messages', 'responses']);
export const geminiGenerateContentCountTokensTarget = chatTargetPicker(['messages']);

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
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentGenerateTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentInterceptors, async () => {
      // Gemini has no native upstream target today — every targetApi we
      // pick is reached via translation. The dispatch threads each branch
      // through `traverseTranslation` so each inner attempt owns its own
      // interceptor chain and rewrite.
      const transCtx = {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      if (targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaAnthropicMessages(p, transCtx),
          translated => anthropicMessagesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
          }),
        );
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaOpenAIResponses(p, transCtx),
          translated => openaiResponsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'openai-chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiGenerateContentViaOpenAIChatCompletions(p, transCtx),
          translated => openaiChatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`geminiGenerateContentAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: GeminiGenerateContentAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiGenerateContentCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: GeminiGenerateContentInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiGenerateContentCountTokensInterceptors, async () => {
      // Gemini countTokens has no native upstream; translate to Anthropic Messages and
      // delegate to `anthropicMessagesAttempt.countTokens`, then reshape the Anthropic Messages
      // count_tokens reply into the Gemini `{ totalTokens }` envelope. The
      // shipped Gemini interceptors that mutate the payload pre-dispatch
      // cannot run via the countTokens interceptor list — the post-`run()`
      // ones inspect event streams the result type cannot carry — so the
      // payload-mutators are applied inline here before translation; the
      // attempt-owned payload clone keeps the caller's source intact.
      const transCtx = {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      const cleaned = invocation.payload;
      stripUnsupportedPartFieldsFromPayload(cleaned);
      stripUnsupportedToolsFromPayload(cleaned);
      delete cleaned.safetySettings;
      const trip = await translateGeminiGenerateContentViaAnthropicMessages(cleaned, transCtx);
      const { stream: _stream, ...target } = trip.target;
      const anthropicMessagesResult = await anthropicMessagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      });
      return reshapeAnthropicMessagesCountAsGeminiGenerateContent(anthropicMessagesResult);
    });
  },
};

// Reshape the Anthropic Messages count_tokens body into the Gemini `{ totalTokens }`
// envelope. The upstream body shape is provider-specific: Anthropic emits
// `{ input_tokens }`, Copilot's translated count emits `{ total_tokens }`;
// either is accepted. A missing or non-numeric figure is surfaced as a
// 502 Google-RPC error so the caller sees a typed Gemini failure rather
// than a passthrough of the upstream shape.
const reshapeAnthropicMessagesCountAsGeminiGenerateContent = (anthropicMessagesResult: PlainResult): PlainResult => {
  if (anthropicMessagesResult.status !== 200) {
    // Empty upstream bodies fall back to a fixed message so the Google-RPC envelope is never empty.
    const text = new TextDecoder().decode(anthropicMessagesResult.body);
    return geminiGenerateContentErrorPlainResult(anthropicMessagesResult.status, text || 'Upstream token counting request failed.', anthropicMessagesResult.upstreamId);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(anthropicMessagesResult.body)); } catch {}
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
    200,
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify({ totalTokens })),
    anthropicMessagesResult.upstreamId,
  );
};

const geminiGenerateContentErrorPlainResult = (status: number, message: string, upstream?: string): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({ error: { code: status, message, status: geminiGenerateContentStatusForHttpStatus(status) } })),
  upstream,
);

const geminiGenerateContentInternalPlainResult = (status: number, error: Error): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({
    error: {
      code: status,
      message: error.message,
      status: geminiGenerateContentStatusForHttpStatus(status),
      type: 'internal_error',
      name: error.name,
      stack: error.stack,
    },
  })),
);
