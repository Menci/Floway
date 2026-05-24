import type { Context } from 'hono';

import { apiKeyUpstreamIdsFromContext } from '../../../../../middleware/auth.ts';
import { httpResponseToResponse, ProviderModelsUnavailableError } from '../../../../providers/models-store.ts';
import { resolveModelForRequest } from '../../../../providers/registry.ts';
import { toInternalDebugError } from '../../../shared/errors/internal-debug-error.ts';
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

    let resp: Response | undefined;
    for (const binding of model.providers) {
      if (!binding.upstreamModel.upstreamEndpoints.includes('messages_count_tokens')) {
        continue;
      }

      const attemptPayload = structuredClone(payload);
      attemptPayload.model = modelId;
      const { model: _model, ...body } = attemptPayload;
      const { response } = await binding.provider.callMessagesCountTokens(binding.upstreamModel, body, undefined, anthropicBeta);
      resp = response;
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
