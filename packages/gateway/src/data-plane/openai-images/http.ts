// POST /v1/images/generations and POST /v1/images/edits, served through the pipeline.
//
// Two endpoints and one family. What the endpoint decides is which contract reads the body —
// generations is always JSON, edits is JSON or a multipart form carrying the files — and
// after that both hand the same canonical request to the same run.

import type { Context } from 'hono';

import { openaiImagesServePipeline } from './pipeline.ts';
import { isFrames, openPrologue, readIngress, serveThrough, type Ingress } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { openaiImagesRequestWantsStream, parseOpenAIImagesEditsRequest, parseOpenAIImagesGenerationsRequest, type ParsedOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';

/** The half both endpoints share: whatever the contract read, hand it over and turn what the
 *  run answered with into a response. The contract reports a malformed request by throwing;
 *  what the client is owed is a 400 carrying the reason. */
const serveOpenAIImages = async (
  c: Context,
  ingress: Ingress,
  read: () => ParsedOpenAIImagesRequest | Promise<ParsedOpenAIImagesRequest>,
): Promise<Response> => {
  let parsed: ParsedOpenAIImagesRequest;
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
  // Whether the answer streams is written in the request the client sent, and the run has to be
  // opened knowing it: the abort controller a streaming run cancels its read with is minted
  // from this flag.
  const wantsStream = openaiImagesRequestWantsStream(request);
  const prologue = openPrologue(c, ingress, { wantsStream, model });

  return await serveThrough(
    c,
    prologue,
    openaiImagesServePipeline(request),
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.openaiImages.wantsStream': wantsStream,
      'request.openaiImages.canonical': request,
      'serve.model': model,
    }) as never,
    facts => {
      const answer = facts['response.openaiImages.rendered'];
      return isFrames(answer) ? { frames: answer } : { body: JSON.stringify(answer), contentType: 'application/json' };
    },
    facts => facts['response.openaiImages.streamedUsage'],
  );
};

export const openaiImagesGenerations = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  return await serveOpenAIImages(c, ingress, () => parseOpenAIImagesGenerationsRequest(ingress.body.bytes));
};

export const openaiImagesEdits = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  // Which of the two bodies arrived is a header's statement and not the payload's, so the
  // contract is handed the media type alongside the bytes.
  return await serveOpenAIImages(c, ingress, () => parseOpenAIImagesEditsRequest(c.req.header('content-type'), ingress.body.bytes));
};
