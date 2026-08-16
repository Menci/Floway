// POST /v1/completions and /completions, served through the pipeline.
//
// The handler is a prologue and an epilogue around `completionsServePipeline`: read what the
// client sent, hand it over, and turn what the run answered with into a response. The one
// thing it decides for itself is whether the request streams, because that is written in the
// body and the run has to be opened knowing it.

import type { Context } from 'hono';

import { completionsServePipeline } from './pipeline.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { move } from '@floway-dev/pipeline';

export const completions = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = prepareJsonModelRequest(ingress.body.bytes, 'Completions');
  if (request.type === 'invalid') {
    // A request the gateway could not read never reaches a pipeline: there is no model to
    // resolve and no attempt to make, so there is nothing for a run to record.
    const refused = openPrologue(c, ingress, { wantsStream: false });
    refused.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(
      refused.gateway,
      Response.json({ error: { message: request.message, type: 'api_error' } }, { status: 400 }),
    );
  }

  const wantsStream = request.body.stream === true;
  const streamOptions = request.body.stream_options as { include_usage?: unknown } | null | undefined;
  const prologue = openPrologue(c, ingress, { wantsStream, model: request.model });

  return await serveThrough(
    c,
    prologue,
    completionsServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.completions.wantsStream': wantsStream,
      // Whether the client asked to *see* the usage chunk. The edge turns it on upstream
      // either way so billing always gets one, and drops it here when it was not asked for.
      'ingress.completions.wantsUsageChunk': streamOptions?.include_usage === true,
      'request.completions.payload': request.body,
      'serve.model': request.model,
    }) as never,
    facts => {
      const rendered = facts['response.completions.rendered'];
      return isFrames(rendered)
        ? { frames: rendered }
        : { body: JSON.stringify(rendered), contentType: 'application/json' };
    },
    facts => facts['response.completions.streamedUsage'],
  );
};
