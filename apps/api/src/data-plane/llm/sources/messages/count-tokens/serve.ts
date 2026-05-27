import type { Context } from 'hono';

import { apiKeyUpstreamIdsFromContext } from '../../../../../middleware/auth.ts';
import { httpResponseToResponse, ProviderModelsUnavailableError } from '../../../../providers/models-store.ts';
import { resolveModelForRequest } from '../../../../providers/registry.ts';
import { type MessagesInvocation, runInterceptors } from '../../../interceptors.ts';
import { toInternalDebugError } from '../../../shared/errors/internal-debug-error.ts';
import { createRequestContext } from '../../execute.ts';
import { bodyAnthropicBetaResponse, bodyBetaParam, parseAnthropicBeta } from '../serve.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    const { id: modelId, model } = await resolveModelForRequest(payload.model, apiKeyUpstreamIdsFromContext(c));

    if (!model) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`,
          },
        },
        404,
      );
    }

    // count_tokens is non-streaming, so there is no downstream abort signal
    // and `clientStream` is false. The request context is still threaded
    // through `runInterceptors` so any future RequestContext-aware
    // count_tokens interceptor sees the same shape it would on the chat path.
    const request = createRequestContext(c, undefined, false);

    let resp: Response | undefined;
    for (const binding of model.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('messages_count_tokens')) {
        continue;
      }

      const attemptPayload = structuredClone(payload);
      attemptPayload.model = modelId;
      // Build a MessagesInvocation matching the chat-planning shape so
      // provider-registered count_tokens interceptors (Copilot's vision,
      // initiator, anthropic-beta header workarounds) run against the same
      // payload, anthropic-beta, and header bag they would on /v1/messages.
      // targetApi is 'messages' because count_tokens hits the Messages
      // endpoint family; there is no separate count_tokens LlmTargetApi.
      const invocation: MessagesInvocation = {
        sourceApi: 'messages',
        targetApi: 'messages',
        model: modelId,
        upstream: binding.upstream,
        upstreamModel: binding.upstreamModel,
        provider: binding.provider,
        enabledFlags: binding.enabledFlags,
        ...(binding.targetInterceptors !== undefined ? { targetInterceptors: binding.targetInterceptors } : {}),
        payload: attemptPayload,
        headers: {},
        ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      };

      resp = await runInterceptors(invocation, request, invocation.targetInterceptors?.messagesCountTokens ?? [], async () => {
        const { model: _model, ...body } = invocation.payload;
        const { response } = await binding.provider.callMessagesCountTokens(invocation.upstreamModel, body, undefined, invocation.headers, invocation.anthropicBeta);
        return response;
      });
      break;
    }

    if (!resp) {
      return c.json(
        {
          error: {
            type: 'invalid_request_error',
            message: `Model ${modelId} does not support the /messages/count_tokens endpoint.`,
          },
        },
        400,
      );
    }

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        'content-type': resp.headers.get('content-type') ?? 'application/json',
      },
    });
  } catch (e) {
    if (e instanceof ProviderModelsUnavailableError) {
      const proxied = httpResponseToResponse(e.httpResponse);
      if (proxied) return proxied;
    }

    return c.json({ error: toInternalDebugError(e, 'messages') }, 502);
  }
};
