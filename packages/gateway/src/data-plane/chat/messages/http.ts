// POST /v1/messages and POST /v1/messages/count_tokens, both served through their own
// pipeline. Generation is one chain; counting is a second operation over the same protocol
// and is a chain of its own rather than another wire under the first.
//
// Each entry is a prologue and an epilogue around that chain: read what the client sent,
// hand it over, and turn what the run answered with into a response. Everything between is
// stages.

import { messagesCountTokensPipeline } from './count-tokens.ts';
import { renderMessagesError } from './errors.ts';
import { messagesKeepAlive, messagesServePipeline } from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { isFrames, openPrologue, readIngress, serveThrough, type Ingress } from '../../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { openChatPrologue } from '../prologue.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { move } from '@floway-dev/pipeline';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

// Reject `anthropic_beta` / `betas` in the body; the Messages protocol carries
// them via the `anthropic-beta` HTTP header.
const rejectBodyBetaResponse = (payload: MessagesPayload): Response | null => {
  const record = payload as unknown as Record<string, unknown>;
  const param = Object.hasOwn(record, 'anthropic_beta')
    ? 'anthropic_beta'
    : Object.hasOwn(record, 'betas')
      ? 'betas'
      : null;
  if (!param) return null;
  return Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );
};

/** A body the gateway could not read is reported in the words this protocol's own clients
 *  parse, rather than as a fault of the gateway's. */
const readRequest = (bytes: Uint8Array): { type: 'ok'; payload: MessagesPayload } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', payload: JSON.parse(new TextDecoder().decode(bytes)) as MessagesPayload };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

/** A request the gateway refused before it reached a pipeline: there is no model to resolve
 *  and no attempt to make, so there is nothing for a run to record beyond the refusal. */
const refuse = (c: AuthedContext, ingress: Ingress, response: Response): Response => {
  const refused = openPrologue(c, ingress, { wantsStream: false });
  refused.gateway.dump?.error('gateway');
  return finalizeGatewayResponse(refused.gateway, response);
};

export const messagesHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') {
      return refuse(c, ingress, Response.json(renderMessagesError(400, request.message), { status: 400 }));
    }

    const { payload } = request;
    const rejected = rejectBodyBetaResponse(payload);
    if (rejected !== null) return refuse(c, ingress, rejected);

    const wantsStream = payload.stream === true;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream,
      model: payload.model,
      storeFactory: apiKey => createNonResponsesSourceStore(apiKey.id),
    });

    return await serveThrough(
      c,
      prologue,
      messagesServePipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'messages',
        'ingress.chat.messages.wantsStream': wantsStream,
        'request.chat.messages': payload,
        'serve.model': payload.model,
      }) as never,
      facts => {
        const rendered = facts['response.chat.messages.rendered'];
        // Anthropic defines a `ping` event and its clients read one, so an idle connection is
        // held open with that rather than with a comment no client sees.
        if (isFrames(rendered)) return { frames: rendered, keepAlive: messagesKeepAlive };
        return { body: JSON.stringify(rendered), contentType: 'application/json' };
      },
      facts => facts['response.chat.messages.streamedUsage'],
    );
  },

  countTokens: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') {
      return refuse(c, ingress, Response.json(renderMessagesError(400, request.message), { status: 400 }));
    }

    const { payload } = request;
    const rejected = rejectBodyBetaResponse(payload);
    if (rejected !== null) return refuse(c, ingress, rejected);

    const prologue = openChatPrologue(c, ingress, {
      wantsStream: false,
      model: payload.model,
      storeFactory: apiKey => createNonResponsesSourceStore(apiKey.id),
    });

    return await serveThrough(
      c,
      prologue,
      messagesCountTokensPipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'messages',
        'request.chat.messages': payload,
        'serve.model': payload.model,
      }) as never,
      // A measurement is one body however the turn went, so there is never a stream to write.
      facts => ({ body: JSON.stringify(facts['response.chat.messages.rendered']), contentType: 'application/json' }),
    );
  },
};
