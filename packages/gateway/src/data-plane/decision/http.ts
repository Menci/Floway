// POST /v1/systemone and POST /v1/decisions, served through the pipeline.
//
// One family behind two routes. Which dialect the client spoke is the route it arrived on, so
// the mount passes it in and the handler carries it into the record as an ingress fact.
// Everything after the parse is stages.

import type { Context } from 'hono';

import { decisionServePipeline } from './pipeline.ts';
import { openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { parseJSONWithRawNumbers, type DecisionProtocol } from '@floway-dev/protocols/common';
import { parseDecisionRequest, type ParsedDecisionRequest } from '@floway-dev/protocols/decision';

// Raw-number parsing keeps a caller's own digits, so a same-dialect upstream is sent the
// numbers the caller wrote.
const readRequest = (
  sourceProtocol: DecisionProtocol,
  bytes: Uint8Array,
): { type: 'ok'; parsed: ParsedDecisionRequest } | { type: 'invalid'; message: string } => {
  let body: unknown;
  try {
    body = parseJSONWithRawNumbers(new TextDecoder().decode(bytes));
  } catch {
    return { type: 'invalid', message: 'Decision request body must be valid JSON' };
  }
  try {
    return { type: 'ok', parsed: parseDecisionRequest(sourceProtocol, body) };
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }
};

export const decision = (sourceProtocol: DecisionProtocol) => async (c: Context): Promise<Response> => {
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
    c,
    prologue,
    decisionServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.decision.sourceProtocol': sourceProtocol,
      'request.decision.canonical': request,
      'serve.model': model,
    }) as never,
    facts => ({ body: facts['response.http.jsonBody']!, contentType: 'application/json' }),
  );
};
