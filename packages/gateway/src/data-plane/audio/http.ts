// POST /v1/audio/transcriptions, served through the pipeline.
//
// The multipart body is read and parsed before routing because field order is unconstrained
// and every candidate builds a fresh body from the entries. What the handler decides for
// itself is written in that form: which of the six renderings the client asked for, and
// whether the request streams — the run has to be opened knowing the second.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040

import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { audioTranscriptionServePipeline } from './pipeline.ts';
import { consoleLogSink } from '../../runtime/log.ts';
import { isFrames, openPrologue, readIngress } from '../pipeline/serve.ts';
import { settleBillable } from '../pipeline/settlement.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { writeSSEFrames } from '../shared/sse.ts';
import { move, run } from '@floway-dev/pipeline';
import { parseAudioTranscriptionResponseFormat, type AudioTranscriptionResponseFormat } from '@floway-dev/protocols/audio';
import { isMultipartFormDataMediaType, sseCommentFrame } from '@floway-dev/protocols/common';
import type { AudioTranscriptionFormEntry } from '@floway-dev/provider';

type PreparedTranscription =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly responseFormat: AudioTranscriptionResponseFormat;
    readonly wantsStream: boolean;
    readonly entries: readonly AudioTranscriptionFormEntry[];
  }
  | { readonly type: 'invalid'; readonly message: string };

const prepareTranscription = async (bytes: Uint8Array, contentType: string | undefined): Promise<PreparedTranscription> => {
  if (!isMultipartFormDataMediaType(contentType)) {
    return { type: 'invalid', message: 'Audio transcription request body must use multipart/form-data.' };
  }

  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { type: 'invalid', message: 'Audio transcription request body must be valid multipart/form-data.' };
  }

  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { type: 'invalid', message: 'Audio transcription request body must include a model field.' };
  }
  const files = form.getAll('file');
  if (files.length === 0 || files.some(file => !(file instanceof File))) {
    return { type: 'invalid', message: 'Audio transcription request body must include a file upload.' };
  }
  const declaredFormat = form.get('response_format');
  if (declaredFormat !== null && typeof declaredFormat !== 'string') {
    return { type: 'invalid', message: 'Audio transcription response_format must be a text field.' };
  }
  let responseFormat: AudioTranscriptionResponseFormat;
  try {
    responseFormat = parseAudioTranscriptionResponseFormat(declaredFormat ?? undefined);
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }

  const entries: AudioTranscriptionFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    entries.push({ name, value });
  }
  return {
    type: 'ok',
    model,
    responseFormat,
    wantsStream: form.get('stream') === 'true',
    entries,
  };
};

/** The client is sent bytes on every path, never a string, so nothing downstream of here
 *  guesses a media type: a `Response` built over a string is labelled `text/plain` by the
 *  platform, and an upstream that declared no media type has not asked for that. */
const bodyOf = (rendered: Record<string, unknown> | Uint8Array): Uint8Array =>
  rendered instanceof Uint8Array ? rendered : new TextEncoder().encode(JSON.stringify(rendered));

/**
 * The epilogue: what the run answered with, as a response.
 *
 * This family writes its own rather than going through `serveThrough`, on two counts that
 * belong to the seam rather than to it.
 *
 * A carried document goes out under the upstream's own media type, and that includes the
 * upstream which declared none — a value `Rendered.contentType` cannot hold.
 *
 * And a transcription's stream states its own outcome in its last event, which is exactly the
 * shape `serveThrough`'s open decision on truncated streams names as the fix: the family's
 * meter reports how the stream ended, because it is the one place that knows. `DeferredUsage`
 * carries only what was billed, so this family settles its own — the write still registered
 * while the request is live, on a promise that resolves with both. Give the seam these two
 * and this handler is `serveThrough` again.
 */
export const audioTranscriptions = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = await prepareTranscription(ingress.body.bytes, c.req.header('content-type'));
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

  const prologue = openPrologue(c, ingress, { wantsStream: request.wantsStream, model: request.model });
  const { facts, drain } = await run(
    audioTranscriptionServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.audioTranscription.responseFormat': request.responseFormat,
      'request.audioTranscription.form': request.entries,
      'serve.model': request.model,
    }) as never,
    prologue.services as never,
  );

  // A stream states what it billed, and whether the transcript ever finished, in its last
  // event — which is after the run has answered. So the stage above the fork stood down and
  // settlement is scheduled here, on the promise the ending stage handed up.
  const outcome = facts['response.audioTranscription.streamedOutcome'];
  if (outcome !== null) {
    prologue.services.background(outcome.then(({ billable, failed }) => {
      settleBillable({ ...prologue.services, log: consoleLogSink }, billable, failed);
    }));
  }

  const rendered = facts['response.audioTranscription.rendered'];
  const status = facts['response.http.status'] as ContentfulStatusCode;
  if (isFrames(rendered)) {
    // Hono's streamSSE builds the response itself, so what the client is to see has to be
    // staged on the context before it is called rather than passed to a constructor.
    for (const [name, value] of facts['response.http.headers']) c.header(name, value);
    c.status(status);
    return finalizeGatewayResponse(prologue.gateway, streamSSE(c, async stream => {
      try {
        await writeSSEFrames(stream, rendered, {
          keepAlive: { frame: sseCommentFrame('keepalive') },
          ...(prologue.gateway.downstreamAbortController === undefined
            ? {}
            : { downstreamAbortController: prologue.gateway.downstreamAbortController }),
        });
      } finally {
        // Reading the frames to the client *is* releasing the body they came from, so the
        // drain waits for that to finish. Draining alongside it would take frames out of the
        // client's own stream — one connection has one reader. A client that stopped reading
        // still gets here, which is what leaves nothing open behind it.
        await drain();
      }
    }));
  }

  // Nothing is left to read: what the client is sent is either the document the run already
  // holds or an object serialized from it, so releasing can start at once.
  prologue.services.background(drain());
  const headers = new Headers(facts['response.http.headers'].map(([name, value]): [string, string] => [name, value]));
  const mediaType = facts['response.audioTranscription.mediaType'];
  if (mediaType !== null) headers.set('content-type', mediaType);
  return finalizeGatewayResponse(prologue.gateway, new Response(bodyOf(rendered) as BodyInit, { status, headers }));
};
