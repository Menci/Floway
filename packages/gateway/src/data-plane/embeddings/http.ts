// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and embeddings capability.
//
// Transitional: the request is already parsed against the embeddings contract and written
// again for the upstream, which is what the pipeline does, while the response is still
// forwarded by the passthrough scaffold. The whole file goes when the route is wired to
// `embeddingsServePipeline`.

import type { Context } from 'hono';

import { tokenUsageFromEmbeddingsBody } from './usage.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { parseEmbeddingsRequest, serializeEmbeddingsRequest, type ParsedEmbeddingsRequest } from '@floway-dev/protocols/embeddings';

// The contract reports a malformed request by throwing; what the client is owed is a 400
// carrying the reason. Reading has to finish before the context takes the bytes.
const readRequest = (bytes: Uint8Array): { type: 'ok'; parsed: ParsedEmbeddingsRequest } | { type: 'invalid'; message: string } => {
  try {
    return { type: 'ok', parsed: parseEmbeddingsRequest(JSON.parse(new TextDecoder().decode(bytes)) as unknown) };
  } catch (e) {
    return { type: 'invalid', message: e instanceof Error ? e.message : String(e) };
  }
};

export const embeddings = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const result = readRequest(requestBody.bytes);
  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (result.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, result.message, 400));
  }
  const { model, request } = result.parsed;

  ctx.dump?.requestedModel(model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/embeddings',
    operation: 'embeddings',
    model,
    kind: 'embedding',
    modelServesEndpoint: candidate => candidate.endpoints.embeddings !== undefined,
    call: async (provider, providerModel, opts) =>
      await provider.instance.callEmbeddings(providerModel, serializeEmbeddingsRequest(request), undefined, opts),
    response: { format: 'json', extractBilling: tokenUsageFromEmbeddingsBody },
  });
  return finalizeGatewayResponse(ctx, response);
};
