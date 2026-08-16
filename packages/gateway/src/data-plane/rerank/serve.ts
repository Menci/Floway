// POST /v1/rerank, /v2/rerank, /jina/v1/rerank and /voyage/v1/rerank, served through the
// pipeline.
//
// One family behind four routes. Which protocol the client spoke is not in the body — the
// route it arrived on is the whole of that statement — so the mount passes it in and the
// handler carries it into the record as an ingress fact. Everything after the parse is
// stages.

import type { Context } from 'hono';

import { rerankServePipeline } from './pipeline.ts';
import { openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import type { RerankSourceProtocol } from '@floway-dev/protocols/common';
import { parseRerankRequest, type ParsedRerankRequest } from '@floway-dev/protocols/rerank';

// The contract reports a malformed request by throwing; what the client is owed is a 400
// carrying the reason. `JSON.parse`'s own wording names a byte offset in a body the client
// already has, so the reason for that one is written here instead.
const readRequest = (
  sourceProtocol: RerankSourceProtocol,
  bytes: Uint8Array,
): { type: 'ok'; parsed: ParsedRerankRequest } | { type: 'invalid'; message: string } => {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { type: 'invalid', message: 'Rerank request body must be valid JSON' };
  }
  try {
    return { type: 'ok', parsed: parseRerankRequest(sourceProtocol, body) };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

export const rerank = (sourceProtocol: RerankSourceProtocol) => async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const result = readRequest(sourceProtocol, ingress.body.bytes);
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
    prologue,
    rerankServePipeline(request),
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.rerank.sourceProtocol': sourceProtocol,
      'request.rerank.canonical': request,
      'serve.model': model,
    }) as never,
    facts => ({ body: JSON.stringify(facts['response.rerank.rendered']), contentType: 'application/json' }),
  );
};
