// POST /v1/images/generations and POST /v1/images/edits, served through the pipeline.
//
// Two endpoints and one family. What the endpoint decides is which contract reads the body —
// generations is always JSON, edits is JSON or a multipart form carrying the files — and
// after that both hand the same canonical request to the same run.

import type { Context } from 'hono';

import { imagesServePipeline } from './pipeline.ts';
import { openPrologue, readIngress, serveThrough, type Ingress } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { parseImagesEditsRequest, parseImagesGenerationsRequest, type ParsedImagesRequest } from '@floway-dev/protocols/images';

/** The half both endpoints share: whatever the contract read, hand it over and turn what the
 *  run answered with into a response. The contract reports a malformed request by throwing;
 *  what the client is owed is a 400 carrying the reason. */
const serveImages = async (
  c: Context,
  ingress: Ingress,
  read: () => ParsedImagesRequest | Promise<ParsedImagesRequest>,
): Promise<Response> => {
  let parsed: ParsedImagesRequest;
  try {
    parsed = await read();
  } catch (error) {
    // A request the gateway could not read never reaches a pipeline: there is no model to
    // resolve and no attempt to make, so there is nothing for a run to record.
    const refused = openPrologue(c, ingress, { wantsStream: false });
    refused.gateway.dump?.error('gateway');
    return finalizeGatewayResponse(
      refused.gateway,
      Response.json(
        { error: { message: error instanceof Error ? error.message : String(error), type: 'api_error' } },
        { status: 400 },
      ),
    );
  }

  const { model, request } = parsed;
  const prologue = openPrologue(c, ingress, { wantsStream: false, model });

  return await serveThrough(
    c,
    prologue,
    imagesServePipeline(request),
    move({
      'ingress.http.headers': prologue.headers,
      'request.images.canonical': request,
      'serve.model': model,
    }) as never,
    facts => ({ body: JSON.stringify(facts['response.images.rendered']), contentType: 'application/json' }),
  );
};

export const imagesGenerations = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  return await serveImages(c, ingress, () => parseImagesGenerationsRequest(ingress.body.bytes));
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  // Which of the two bodies arrived is a header's statement and not the payload's, so the
  // contract is handed the media type alongside the bytes.
  return await serveImages(c, ingress, () => parseImagesEditsRequest(c.req.header('content-type'), ingress.body.bytes));
};
