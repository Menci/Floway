// POST /v1/audio/transcriptions, served through the pipeline.
//
// The multipart body is read and parsed before routing because field order is unconstrained
// and every candidate builds a fresh body from the entries. What the handler decides for
// itself is written in that form: which of the six renderings the client asked for, and
// whether the request streams — the run has to be opened knowing the second.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040

import type { Context } from 'hono';

import type { AudioFormEntry } from './facts.ts';
import { openaiAudioTranscriptionServePipeline } from './pipeline.ts';
import { isFrames, openPrologue, readIngress, serveThrough } from '../pipeline/serve.ts';
import { finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { move } from '@floway-dev/pipeline';
import { isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import { parseOpenAIAudioTranscriptionResponseFormat, type OpenAIAudioTranscriptionResponseFormat } from '@floway-dev/protocols/openai-audio';

type PreparedOpenAIAudioTranscription =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly responseFormat: OpenAIAudioTranscriptionResponseFormat;
    readonly wantsStream: boolean;
    readonly entries: readonly AudioFormEntry[];
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

  const entries: AudioFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    entries.push({
      name, value: typeof value === 'string' ? value : {
        name: value.name,
        type: value.type,
        lastModified: value.lastModified,
        bytes: new Uint8Array(await value.arrayBuffer()),
      },
    });
  }
  return {
    type: 'ok',
    model,
    responseFormat,
    wantsStream: form.get('stream') === 'true',
    entries,
  };
};

/**
 * The epilogue: what the run answered with, as a response.
 *
 * It is `serveThrough` like every other family, and it took two things at the seam to make it
 * one. A carried document goes out under the upstream's own media type, including the upstream
 * that declared none — so `Rendered.contentType` carries a null and the seam answers without
 * the header rather than inventing one. And a transcription's stream states its own outcome in
 * its last event, which the family's meter reads because it is the one place that knows — so
 * the deferred reading holds both what was billed and whether the stream finished,
 * settled from one promise while the request is still live.
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
      return { body: (rendered instanceof Uint8Array ? rendered : facts['response.http.jsonBody']!) as BodyInit, contentType: facts['response.openaiAudioTranscription.mediaType'] };
    },
  );
};
