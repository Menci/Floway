// POST /v1/audio/transcriptions — buffered OpenAI-compatible multipart
// transcription. The full body is parsed before routing because multipart
// field order is unconstrained; providers receive ordered semantic entries
// and rebuild a fresh body per candidate.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040

import type { Context } from 'hono';

import { respondAudioTranscription } from './respond.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import type { AudioTranscriptionFormEntry } from '@floway-dev/provider';

type PreparedTranscription =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly wantsStream: boolean;
    readonly entries: readonly AudioTranscriptionFormEntry[];
  }
  | { readonly type: 'invalid'; readonly message: string };

const prepareTranscription = async (bytes: Uint8Array, contentType: string | undefined): Promise<PreparedTranscription> => {
  if (contentType === undefined || contentType.replace(/;.*$/u, '').trim().toLowerCase() !== 'multipart/form-data') {
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

  const entries: AudioTranscriptionFormEntry[] = [];
  for (const [name, value] of form.entries()) {
    entries.push({ name, value });
  }
  return {
    type: 'ok',
    model,
    wantsStream: form.get('stream') === 'true',
    entries,
  };
};

export const audioTranscriptions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = await prepareTranscription(requestBody.bytes, c.req.header('content-type'));
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: request.type === 'ok' ? request.wantsStream : false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/audio/transcriptions',
    operation: 'audio_transcription',
    model: request.model,
    kind: 'transcription',
    modelServesEndpoint: model => model.endpoints.audioTranscriptions !== undefined,
    call: (provider, model, opts) => provider.instance.callAudioTranscriptions(model, { entries: request.entries }, ctx.abortSignal, opts),
    response: { format: 'strategy', respond: respondAudioTranscription },
  });
  return finalizeGatewayResponse(ctx, response);
};
