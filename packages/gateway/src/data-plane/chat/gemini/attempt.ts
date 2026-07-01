import { geminiStatusForHttpStatus } from './errors.ts';
import { geminiCountTokensInterceptors, geminiInterceptors } from './interceptors/index.ts';
import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { chatTargetPicker } from '../shared/attempt-helpers.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ModelCandidate, plainResult, type ExecuteResult, type GeminiInvocation, type PlainResult } from '@floway-dev/provider';
import { translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses } from '@floway-dev/translate';

// Gemini has no native upstream target in the provider API; prefer Chat
// Completions, then Messages, then Responses for generate. countTokens has
// no translation path beyond native Messages count_tokens.
export const geminiGenerateTarget = chatTargetPicker(['chat-completions', 'messages', 'responses']);
export const geminiCountTokensTarget = chatTargetPicker(['messages']);

export interface GeminiAttemptGenerateArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export interface GeminiAttemptCountTokensArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  readonly candidate: ModelCandidate;
  readonly headers: Headers;
}

export const geminiAttempt = {
  generate: async (args: GeminiAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> => {
    const { payload, ctx, candidate, headers } = args;
    const targetApi = geminiGenerateTarget.pick(candidate.model.endpoints);
    const invocation: GeminiInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiInterceptors, async () => {
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
          p => translateGeminiViaMessages(p, transCtx),
          translated => messagesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiViaResponses(p, transCtx),
          translated => responsesAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      if (targetApi === 'chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateGeminiViaChatCompletions(p, transCtx),
          translated => chatCompletionsAttempt.generate({
            payload: translated, ctx, candidate, headers: invocation.headers,
          }),
        );
      }
      throw new Error(`geminiAttempt.generate: unexpected targetApi '${targetApi as string}'`);
    });
  },

  countTokens: async (args: GeminiAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload, ctx, candidate, headers } = args;
    const targetApi = geminiCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: GeminiInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiCountTokensInterceptors, async () => {
      // Gemini countTokens has no native upstream; translate to Messages and
      // delegate to `messagesAttempt.countTokens`, then reshape the Messages
      // count_tokens reply into the Gemini `{ totalTokens }` envelope. The
      // shipped Gemini interceptors that mutate the payload pre-dispatch
      // cannot run via the countTokens interceptor list — the post-`run()`
      // ones inspect event streams the result type cannot carry — so the
      // payload-mutators are applied inline here on a structuredClone of
      // the source so the caller's payload stays intact.
      const transCtx = {
        model: candidate.model.id,
        fallbackMaxOutputTokens: candidate.model.limits.max_output_tokens,
      };
      const cleaned = structuredClone(invocation.payload);
      stripUnsupportedPartFieldsFromPayload(cleaned);
      stripUnsupportedToolsFromPayload(cleaned);
      delete cleaned.safetySettings;
      const trip = await translateGeminiViaMessages(cleaned, transCtx);
      const { stream: _stream, ...target } = trip.target;
      const messagesResult = await messagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers,
      });
      return reshapeMessagesCountAsGemini(messagesResult);
    });
  },
};

// Reshape the Messages count_tokens body into the Gemini `{ totalTokens }`
// envelope. The upstream body shape is provider-specific: Anthropic emits
// `{ input_tokens }`, Copilot's translated count emits `{ total_tokens }`;
// either is accepted. A missing or non-numeric figure is surfaced as a
// 502 Google-RPC error so the caller sees a typed Gemini failure rather
// than a passthrough of the upstream shape.
const reshapeMessagesCountAsGemini = (messagesResult: PlainResult): PlainResult => {
  if (messagesResult.status !== 200) {
    // Empty upstream bodies fall back to a fixed message so the Google-RPC envelope is never empty.
    const text = new TextDecoder().decode(messagesResult.body);
    return geminiErrorPlainResult(messagesResult.status, text || 'Upstream token counting request failed.', messagesResult.upstream);
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder().decode(messagesResult.body)); } catch {}
  const upstreamTokenCounts = decoded && typeof decoded === 'object'
    ? decoded as { input_tokens?: unknown; total_tokens?: unknown }
    : {};
  const totalTokens = typeof upstreamTokenCounts.input_tokens === 'number'
    ? upstreamTokenCounts.input_tokens
    : typeof upstreamTokenCounts.total_tokens === 'number'
      ? upstreamTokenCounts.total_tokens
      : null;
  if (totalTokens === null) {
    return geminiInternalPlainResult(502, new Error('Invalid upstream token counting response.'));
  }
  return plainResult(
    200,
    new Headers({ 'content-type': 'application/json' }),
    new TextEncoder().encode(JSON.stringify({ totalTokens })),
    messagesResult.upstream,
  );
};

const geminiErrorPlainResult = (status: number, message: string, upstream?: string): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({ error: { code: status, message, status: geminiStatusForHttpStatus(status) } })),
  upstream,
);

const geminiInternalPlainResult = (status: number, error: Error): PlainResult => plainResult(
  status,
  new Headers({ 'content-type': 'application/json' }),
  new TextEncoder().encode(JSON.stringify({
    error: {
      code: status,
      message: error.message,
      status: geminiStatusForHttpStatus(status),
      type: 'internal_error',
      name: error.name,
      stack: error.stack,
    },
  })),
);
