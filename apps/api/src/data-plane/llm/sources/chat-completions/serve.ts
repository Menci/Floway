import type { Context } from 'hono';

import { chatCompletionsSourceInterceptors } from './interceptors/index.ts';
import { respondChatCompletions } from './respond.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type ChatCompletionsInvocation, type LlmTargetApi, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateChatCompletionsViaMessages, translateChatCompletionsViaResponses, viaTranslation } from '@floway-dev/translate';

const chatInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'chat-completions' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
  headers: {} as Record<string, string>,
});

export const serveChatCompletions = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;
  // Target interceptors may force upstream usage for gateway accounting, but
  // Chat SSE exposes usage only when the caller requested `include_usage`.
  let includeUsageChunk = false;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('responses')) return 'responses';
    return null;
  };

  try {
    const payload = await c.req.json<ChatCompletionsPayload>();
    includeUsageChunk = payload.stream_options?.include_usage === true;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model, request.apiKeyUpstreamIds);
    let result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const target = pickTarget(binding.upstreamModel.upstreamEndpoints);
        if (!target) continue;

        const invocation: ChatCompletionsInvocation = chatInvocation(binding, target, model, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<ChatCompletionsPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ChatCompletionChunk>>>> = {
          'chat-completions': async srcPayload => await emitToChatCompletions({ ...invocation, payload: srcPayload }, request),
          messages: viaTranslation(translateChatCompletionsViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(chatInvocation(binding, 'messages', model, tgtPayload), request)),
          responses: viaTranslation(translateChatCompletionsViaResponses, async (tgtPayload: ResponsesPayload) =>
            await emitToResponses(chatInvocation(binding, 'responses', model, tgtPayload), request)),
        };

        result = await runInterceptors(invocation, request, [...chatCompletionsSourceInterceptors, ...(binding.sourceInterceptors?.chatCompletions ?? [])], () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/chat/completions');
    }

    return await respondChatCompletions(c, result, wantsStream, includeUsageChunk, request, downstreamAbortController);
  } catch (error) {
    return await respondChatCompletions(
      c,
      sourceErrorResult(error, {
        sourceApi: 'chat-completions',
        internalStatus: 502,
      }),
      false,
      includeUsageChunk,
      request, downstreamAbortController,
    );
  }
};
