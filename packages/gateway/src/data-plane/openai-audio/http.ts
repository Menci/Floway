// POST /v1/audio/transcriptions, served through the pipeline.
//
// The multipart body is read and parsed before routing because field order is unconstrained
// and every candidate builds a fresh body from the entries. What the handler decides for
// itself is written in that form: which of the six renderings the client asked for, and
// whether the request streams — the run has to be opened knowing the second.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040

import type { Context } from 'hono';

import { openaiAudioTranscriptionServePipeline } from './pipeline.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import { parseOpenAIAudioTranscriptionResponseFormat, type OpenAIAudioTranscriptionResponseFormat } from '@floway-dev/protocols/openai-audio';
import type { OpenAIAudioTranscriptionFormEntry } from '@floway-dev/provider';

type PreparedOpenAIAudioTranscription =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly responseFormat: OpenAIAudioTranscriptionResponseFormat;
    readonly wantsStream: boolean;
    readonly entries: readonly OpenAIAudioTranscriptionFormEntry[];
  }
  | { readonly type: 'invalid'; readonly message: string };

const prepareOpenAIAudioTranscription = async (bytes: Uint8Array, contentType: string | undefined): Promise<PreparedOpenAIAudioTranscription> => {
  if (!isMultipartFormDataMediaType(contentType)) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must use multipart/form-data.' };
  }

  let form: FormData;
  try {
    form = await new Response(bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must be valid multipart/form-data.' };
  }

  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must include a model field.' };
  }
  const files = form.getAll('file');
  if (files.length === 0 || files.some(file => !(file instanceof File))) {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions request body must include a file upload.' };
  }
  const declaredFormat = form.get('response_format');
  if (declaredFormat !== null && typeof declaredFormat !== 'string') {
    return { type: 'invalid', message: 'OpenAI Audio Transcriptions response_format must be a text field.' };
  }
  let responseFormat: OpenAIAudioTranscriptionResponseFormat;
  try {
    responseFormat = parseOpenAIAudioTranscriptionResponseFormat(declaredFormat ?? undefined);
  } catch (error) {
    return { type: 'invalid', message: error instanceof Error ? error.message : String(error) };
  }

  const entries: OpenAIAudioTranscriptionFormEntry[] = [];
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
export const openaiAudioTranscriptions = async (c: Context): Promise<Response> => {
  const ingress = await readIngress(c);
  const request = await prepareOpenAIAudioTranscription(ingress.body.bytes, c.req.header('content-type'));
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

  return await serveThrough(
    c,
    prologue,
    openaiAudioTranscriptionServePipeline,
    move({
      'ingress.http.headers': prologue.headers,
      'ingress.openaiAudioTranscription.responseFormat': request.responseFormat,
      'request.openaiAudioTranscription.form': request.entries,
      'serve.model': request.model,
    }) as never,
    facts => {
      const rendered = facts['response.openaiAudioTranscription.rendered'];
      if (isFrames(rendered)) return { frames: rendered };
      // The upstream's own media type, or none where it declared none: a document this
      // gateway carried rather than wrote is not one it can describe.
      return { body: bodyOf(rendered) as BodyInit, contentType: facts['response.openaiAudioTranscription.mediaType'] };
    },
    facts => facts['response.openaiAudioTranscription.streamedOutcome'],
  );
};
