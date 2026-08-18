// POST /v1/chat/completions, served through the pipeline.
//
// The handler is a prologue and an epilogue around `chatCompletionsServePipeline`: read what
// the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages.
//
// Two things are decided here because only the entry knows them, and both are read before any
// stage can rewrite the payload they are read from: whether the client asked to stream, which
// the run has to be opened knowing, and whether it asked to be shown the usage chunk that
// metering asks the upstream for on every streaming turn.

import { chatCompletionsServePipeline } from './pipeline.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../../shared/gateway-ctx.ts';
import { openChatPrologue } from '../prologue.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { move } from '@floway-dev/pipeline';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

/** A body the gateway could not read is reported in the words the protocol's own clients
 *  parse, rather than as a fault of the gateway's. */
const readRequest = (bytes: Uint8Array): { type: 'ok'; payload: ChatCompletionsPayload } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', payload: JSON.parse(new TextDecoder().decode(bytes)) as ChatCompletionsPayload };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

export const chatCompletionsHttp = {
  generate: async (c: AuthedContext): Promise<Response> => {
    const ingress = await readIngress(c);
    const request = readRequest(ingress.body.bytes);
    if (request.type === 'invalid') {
      // A request the gateway could not read never reaches a pipeline: there is no model to
      // resolve and no attempt to make, so there is nothing for a run to record.
      const refused = openPrologue(c, ingress, { wantsStream: false });
      refused.gateway.dump?.error('gateway');
      return finalizeGatewayResponse(
        refused.gateway,
        Response.json({ error: { message: request.message, type: 'invalid_request_error' } }, { status: 400 }),
      );
    }

    const { payload } = request;
    const wantsStream = payload.stream === true;
    const prologue = openChatPrologue(c, ingress, {
      wantsStream,
      model: payload.model,
      storeFactory: apiKey => createNonResponsesSourceStore(apiKey.id),
    });

    return await serveThrough(
      c,
      prologue,
      chatCompletionsServePipeline(payload),
      move({
        'ingress.http.headers': prologue.headers,
        'ingress.chat.sourceProtocol': 'chatCompletions',
        'ingress.chat.chatCompletions.wantsStream': wantsStream,
        'ingress.chat.chatCompletions.wantsUsageChunk': payload.stream_options?.include_usage === true,
        'request.chat.chatCompletions': payload,
        'serve.model': payload.model,
      }) as never,
      facts => {
        const rendered = facts['response.chat.chatCompletions.rendered'];
        if (isFrames(rendered)) return { frames: rendered };
        return { body: JSON.stringify(rendered), contentType: 'application/json' };
      },
      facts => facts['response.chat.chatCompletions.streamedUsage'],
    );
  },
};
