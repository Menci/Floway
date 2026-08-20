// POST /v1/embeddings, served through the pipeline.
//
// The handler is a prologue and an epilogue around `openaiEmbeddingsServePipeline`: parse what
// the client sent, hand it over, and turn what the run answered with into a response.
// Everything between is stages.

import type { Context } from 'hono';

import { openaiEmbeddingsServePipeline } from './pipeline.ts';
import { openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { parseOpenAIEmbeddingsRequest, type ParsedOpenAIEmbeddingsRequest } from '@floway-dev/protocols/openai-embeddings';

// The contract reports a malformed request by throwing; what the client is owed is a 400
// carrying the reason.
const readRequest = (bytes: Uint8Array): { type: 'ok'; parsed: ParsedOpenAIEmbeddingsRequest } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', parsed: parseOpenAIEmbeddingsRequest(JSON.parse(new TextDecoder().decode(bytes)) as unknown) };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

export const openaiEmbeddings = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const result = readRequest(ingress.body.bytes);
  if (result.type === 'invalid') {
    // A request the gateway could not read never reaches a pipeline: there is no model to
    // resolve and no attempt to make, so there is nothing for a run to record.
    const refused = openPrologue(c, ingress, { wantsStream: false });
    refused.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(
      refused.gateway,
      Response.json({ error: { message: result.message, type: 'api_error' } }, { status: 400 }),
    );
  }

  const { model, request } = result.parsed;
  const prologue = openPrologue(c, ingress, { wantsStream: false, model });

  return await serveThrough(
    c,
    prologue,
    openaiEmbeddingsServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.openaiEmbeddings.encodingFormat': request.encodingFormat,
      'request.openaiEmbeddings.canonical': request,
      'serve.model': model,
    }) as never,
    facts => ({ body: JSON.stringify(facts['response.openaiEmbeddings.rendered']), contentType: 'application/json' }),
  );
};
