import type { Context } from 'hono';

import { responsesSourceInterceptors } from './interceptors/index.ts';
import { respondResponses } from './respond.ts';
import { resolveModelForRequest } from '../../../providers/registry.ts';
import type { ProviderModelRecord } from '../../../providers/types.ts';
import { type LlmTargetApi, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { emitToChatCompletions } from '../../targets/chat-completions/emit.ts';
import { emitToMessages } from '../../targets/messages/emit.ts';
import { emitToResponses } from '../../targets/responses/emit.ts';
import { createRequestContext, openAiMissingModelResult, openAiUnsupportedEndpointResult, sourceErrorResult } from '../execute.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponseItemReference, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type SourceEmit, translateResponsesViaChatCompletions, translateResponsesViaMessages, viaTranslation } from '@floway-dev/translate';

const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';

const isItemReferenceInput = (item: unknown): item is ResponseItemReference =>
  typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'item_reference';

// previous_response_id and item_reference rely on stateful server-side conversation history
// that this gateway does not hold, so any such reference is "not found" from our perspective.
// We return OpenAI's exact "not found" envelopes (status, message, param, code) rather than
// a custom "unsupported" error so that clients which key fallback off this contract — codex,
// cline, openai-agents-python, etc., matching `code: previous_response_not_found` or the
// `"Previous response with id" ... "not found"` / `"Item with id" ... "not found"` substrings —
// transparently retry with the full input.
// Verbatim payloads cross-verified from real upstream captures:
// - https://github.com/cline/cline/issues/9399
// - https://github.com/microsoft/semantic-kernel/issues/13128
// - https://github.com/router-for-me/CLIProxyAPI/issues/999
// - https://github.com/openai/openai-agents-python/issues/2020
const statefulContinuationNotFoundResponse = (payload: ResponsesPayload): Response | undefined => {
  if (payload.previous_response_id !== undefined && payload.previous_response_id !== null) {
    return Response.json(
      {
        error: {
          message: `Previous response with id '${payload.previous_response_id}' not found.`,
          type: 'invalid_request_error',
          param: 'previous_response_id',
          code: 'previous_response_not_found',
        },
      },
      { status: 400 },
    );
  }
  if (Array.isArray(payload.input)) {
    const itemRef = payload.input.find(isItemReferenceInput);
    if (itemRef) {
      return Response.json(
        {
          error: {
            message: `Item with id '${itemRef.id}' not found.`,
            type: 'invalid_request_error',
            param: 'input',
            code: null,
          },
        },
        { status: 404 },
      );
    }
  }
  return undefined;
};

const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;

  // TODO: Replace this source-entry hardcode with generic model alias support.
  // Codex sends auto-review requests over the Responses wire API, so rewriting
  // here keeps downstream routing, performance telemetry, and usage accounting
  // on the real model name.
  // References:
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/model-provider/src/provider.rs#L73-L96
  // https://github.com/openai/codex/blob/e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df/codex-rs/codex-api/src/endpoint/responses.rs#L102-L134
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

const responsesInvocation = <TPayload extends { model: string }>(
  binding: ProviderModelRecord,
  targetApi: LlmTargetApi,
  model: string,
  payload: TPayload,
) => ({
  sourceApi: 'responses' as const,
  targetApi,
  model,
  upstream: binding.upstream,
  upstreamModel: binding.upstreamModel,
  provider: binding.provider,
  enabledFlags: binding.enabledFlags,
  ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
  payload,
});

export const serveResponses = async (c: Context): Promise<Response> => {
  let request = createRequestContext(c, undefined, false);
  let downstreamAbortController: AbortController | undefined;

  const pickTarget = (endpoints: readonly ModelEndpoint[]): LlmTargetApi | null => {
    if (endpoints.includes('responses')) return 'responses';
    if (endpoints.includes('messages')) return 'messages';
    if (endpoints.includes('chat_completions')) return 'chat-completions';
    return null;
  };

  try {
    const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>());
    const notFound = statefulContinuationNotFoundResponse(payload);
    if (notFound) return notFound;
    const wantsStream = payload.stream === true;
    downstreamAbortController = wantsStream ? new AbortController() : undefined;
    request = createRequestContext(c, downstreamAbortController?.signal, wantsStream);

    const { id: model, model: resolved } = await resolveModelForRequest(payload.model, request.apiKeyUpstreamIds);
    let result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | undefined;

    if (!resolved) {
      result = openAiMissingModelResult(model);
    } else {
      for (const binding of resolved.providers) {
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = model;
        const target = pickTarget(binding.upstreamModel.upstreamEndpoints);
        if (!target) continue;

        const invocation: ResponsesInvocation = responsesInvocation(binding, target, model, attemptPayload);

        const emits: Record<LlmTargetApi, SourceEmit<ResponsesPayload, { fallbackMaxOutputTokens?: number }, ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>>> = {
          responses: async srcPayload => await emitToResponses({ ...invocation, payload: srcPayload }, request),
          messages: viaTranslation(translateResponsesViaMessages, async (tgtPayload: MessagesPayload) =>
            await emitToMessages(responsesInvocation(binding, 'messages', model, tgtPayload), request)),
          'chat-completions': viaTranslation(translateResponsesViaChatCompletions, async (tgtPayload: ChatCompletionsPayload) =>
            await emitToChatCompletions(responsesInvocation(binding, 'chat-completions', model, tgtPayload), request)),
        };

        result = await runInterceptors(invocation, request, [...responsesSourceInterceptors, ...(binding.sourceInterceptors?.responses ?? [])], () =>
          emits[target](invocation.payload, { model, fallbackMaxOutputTokens: binding.upstreamModel.limits.max_output_tokens }));
        break;
      }

      result ??= openAiUnsupportedEndpointResult(model, '/responses');
    }

    return await respondResponses(c, result, wantsStream, request, downstreamAbortController);
  } catch (error) {
    return await respondResponses(
      c,
      sourceErrorResult(error, {
        sourceApi: 'responses',
        internalStatus: 502,
      }),
      false,
      request, downstreamAbortController,
    );
  }
};
