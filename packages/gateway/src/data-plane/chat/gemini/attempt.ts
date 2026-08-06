import { geminiStatusForHttpStatus } from './errors.ts';
import { geminiCountTokensInterceptors, geminiInterceptors } from './interceptors/index.ts';
import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import { mergeForwardedUpstreamHeaders } from '../../shared/upstream-response.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import { chatTargetPicker } from '../shared/target-picker.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import { type ModelCandidate, plainResult, type ExecuteResult, type GeminiInvocation, type PlainResult, toInternalDebugError } from '@floway-dev/provider';
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
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
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
            payload: translated, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
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
    const { payload: sourcePayload, ctx, candidate, headers: sourceHeaders } = args;
    const payload = structuredClone(sourcePayload);
    const headers = new Headers(sourceHeaders);
    const targetApi = geminiCountTokensTarget.pick(candidate.model.endpoints);
    const invocation: GeminiInvocation = { payload, candidate, targetApi, headers };
    return await runInterceptors(invocation, ctx, geminiCountTokensInterceptors, async () => {
      // Gemini countTokens has no native upstream; translate to Messages and
      // delegate to `messagesAttempt.countTokens`, then reshape the Messages
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
      const trip = await translateGeminiViaMessages(cleaned, transCtx);
      const { stream: _stream, ...target } = trip.target;
      const messagesResult = await messagesAttempt.countTokens({
        payload: target, ctx, candidate, headers: invocation.headers, anthropicBeta: [],
      });
      return reshapeMessagesCountAsGemini(messagesResult);
    });
  },
};

// Reshape the Messages count_tokens body into the Gemini `{ totalTokens }`
// envelope. The upstream body shape is provider-specific: Anthropic emits
// `{ input_tokens }`, Copilot's translated count emits `{ total_tokens }`;
// either is accepted, and both may appear only when they agree. Counts must
// be non-negative safe integers; every other shape becomes a typed 502
// Google-RPC error.
const reshapeMessagesCountAsGemini = (messagesResult: PlainResult): PlainResult => {
  if (messagesResult.status !== 200) {
    // Empty upstream bodies fall back to a fixed message so the Google-RPC envelope is never empty.
    const text = new TextDecoder().decode(messagesResult.body);
    const status = validUpstreamErrorStatus(messagesResult.status);
    return geminiErrorPlainResult(status, text || 'Upstream token counting request failed.', messagesResult.headers, messagesResult.upstreamId);
  }
  let totalTokens: number;
  try {
    totalTokens = parseMessagesTokenCount(messagesResult.body);
  } catch (error) {
    return geminiInternalPlainResult(502, error, messagesResult.headers, messagesResult.upstreamId);
  }
  return plainResult(
    200,
    geminiJsonHeaders(messagesResult.headers),
    new TextEncoder().encode(JSON.stringify({ totalTokens })),
    messagesResult.upstreamId,
  );
};

const validUpstreamErrorStatus = (status: number): number =>
  Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;

const geminiJsonHeaders = (upstream: Headers | undefined): Headers =>
  mergeForwardedUpstreamHeaders({ 'content-type': 'application/json' }, upstream);

const isTokenCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const parseMessagesTokenCount = (body: Uint8Array): number => {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(body)) as unknown;
  } catch (cause) {
    throw new Error('Invalid upstream token counting response.', { cause });
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('Invalid upstream token counting response.');
  }

  const { input_tokens: inputTokens, total_tokens: totalTokens } = decoded as { input_tokens?: unknown; total_tokens?: unknown };
  if (inputTokens === undefined && totalTokens === undefined) throw new Error('Invalid upstream token counting response.');
  if (inputTokens !== undefined && !isTokenCount(inputTokens)) throw new Error('Invalid upstream token counting response.');
  if (totalTokens !== undefined && !isTokenCount(totalTokens)) throw new Error('Invalid upstream token counting response.');
  if (inputTokens !== undefined && totalTokens !== undefined && inputTokens !== totalTokens) {
    throw new Error('Invalid upstream token counting response.');
  }
  if (inputTokens !== undefined) return inputTokens;
  if (totalTokens !== undefined) return totalTokens;
  throw new Error('Invalid upstream token counting response.');
};

const geminiErrorPlainResult = (status: number, message: string, headers: Headers | undefined, upstream?: string): PlainResult => plainResult(
  status,
  geminiJsonHeaders(headers),
  new TextEncoder().encode(JSON.stringify({ error: { code: status, message, status: geminiStatusForHttpStatus(status) } })),
  upstream,
);

const geminiInternalPlainResult = (status: number, error: unknown, headers: Headers | undefined, upstream?: string): PlainResult => {
  const debug = toInternalDebugError(error);
  return plainResult(
    status,
    geminiJsonHeaders(headers),
    new TextEncoder().encode(JSON.stringify({
      error: {
        code: status,
        status: geminiStatusForHttpStatus(status),
        ...debug,
      },
    })),
    upstream,
  );
};
