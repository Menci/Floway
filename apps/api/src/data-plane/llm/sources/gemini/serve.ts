import type { Context } from 'hono';

import { geminiSourceInterceptors } from './interceptors/index.ts';
import { respondGemini } from './respond.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type GeminiInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, jsonUpstreamErrorResult, sourceErrorResult } from '../execute.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateGeminiViaChatCompletions, translateGeminiViaMessages, translateGeminiViaResponses, viaTranslation } from '@floway-dev/translate';

const missingGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(404, {
    error: {
      code: 404,
      message: `Model ${model} is not available on any configured upstream.`,
      status: 'NOT_FOUND',
    },
  });

const unsupportedGeminiModelResult = (model: string) =>
  jsonUpstreamErrorResult(400, {
    error: {
      code: 400,
      message: `Model ${model} does not support the Gemini generateContent endpoint.`,
      status: 'INVALID_ARGUMENT',
    },
  });

const geminiInvocation = <TPayload>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'gemini' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveGemini = async (c: Context, model: string, wantsStream: boolean): Promise<Response> => {
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

  // Gemini has no native upstream target in the provider API; prefer Chat
  // Completions, then Messages, then Responses.
  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    return null;
  };

  try {
    const payload = await c.req.json<GeminiGenerateContentRequest>();

    const { id: modelId, model: resolved } = await resolveModelForRequest(model, request.apiKeyUpstreamIds);
    let result: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | undefined;

    if (!resolved) {
      result = missingGeminiModelResult(modelId);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        const target = pickTarget(binding.upstreamModel.upstreamEndpoints);
        if (!target) continue;

        // Gemini source payload has no `model` field on the request body; the
        // invocation carries the resolved id for telemetry/dispatch use.
        const invocation: GeminiInvocation = geminiInvocation(binding, target, modelId, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<GeminiGenerateContentRequest, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<GeminiStreamEvent>>>> = {
          messages: viaTranslation(translateGeminiViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(geminiInvocation(binding, 'messages', modelId, tgtPayload), request)),
          responses: viaTranslation(translateGeminiViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(geminiInvocation(binding, 'responses', modelId, tgtPayload), request)),
          'chat-completions': viaTranslation(translateGeminiViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(geminiInvocation(binding, 'chat-completions', modelId, tgtPayload), request)),
        };

        result = await runInterceptors(invocation, request, [...geminiSourceInterceptors, ...(binding.sourceInterceptors?.gemini ?? [])], () =>
          emits[target](invocation.payload, { model: modelId, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
        break;
      }

      result ??= unsupportedGeminiModelResult(modelId);
    }

    return await respondGemini(c, result, wantsStream, request, downstreamAbortController);
  } catch (error) {
    return await respondGemini(
      c,
      sourceErrorResult(error, {
        sourceApi: 'gemini',
        internalStatus: 500,
      }),
      false,
      request, downstreamAbortController,
    );
  }
};
