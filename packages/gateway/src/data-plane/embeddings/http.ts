// POST /v1/embeddings, served through the pipeline.
//
// The handler is a prologue and an epilogue around `embeddingsServePipeline`: parse what
// the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages.

import { move } from '@floway-dev/pipeline';
import { parseEmbeddingsRequest, type ParsedEmbeddingsRequest } from '@floway-dev/protocols/embeddings';
import type { Context } from 'hono';

import { embeddingsServePipeline } from './pipeline.ts';
import { openPrologue, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';

// The contract reports a malformed request by throwing; what the client is owed is a 400
// carrying the reason.
const readRequest = (bytes: Uint8Array): { type: 'ok'; parsed: ParsedEmbeddingsRequest } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', parsed: parseEmbeddingsRequest(JSON.parse(new TextDecoder().decode(bytes)) as unknown) };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

export const embeddings = async (c: Context): Promise<Response> => {
  const prologue = await openPrologue(c, { wantsStream: false });
  const result = readRequest(prologue.bytes);
  if (result.type === 'invalid') {
    // A request the gateway could not read never reaches a pipeline: there is no model to
    // resolve and no attempt to make, so there is nothing for a run to record.
    prologue.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(
      prologue.gateway,
      Response.json({ error: { message: result.message, type: 'api_error' } }, { status: 400 }),
    );
  }

  const { model, request } = result.parsed;
  prologue.gateway.dump?.requestedModel(model);

  return await serveThrough(
    prologue,
    embeddingsServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.embeddings.encodingFormat': request.encodingFormat,
      'request.embeddings.canonical': request,
      'serve.model': model,
    }) as never,
    facts => ({ body: JSON.stringify(facts['response.embeddings.rendered']), contentType: 'application/json' }),
  );
};
