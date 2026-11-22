// POST /v1/audio/transcriptions — buffered OpenAI-compatible multipart
// transcription. The full body is parsed before routing because multipart
// field order is unconstrained; providers receive ordered semantic entries
// and rebuild a fresh body per candidate.
// https://github.com/openai/openai-openapi/blob/db3e53198a66732cfe161339ea63bf36fc0137ad/openapi.yaml#L714-L1040

import type { Context } from 'hono';

import { openaiAudioTranscriptionsPipeline } from './pipeline.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import {
  buildDownstreamWireUrl,
  createGatewayPipelineServices,
  inboundHeaderEntriesFromHono,
  runGatewayHttpPipeline,
} from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { readRequestBody, takeRequestBody } from '../shared/request-body.ts';
import { isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { MultipartField } from '@floway-dev/provider';

type PreparedOpenAIAudioTranscription =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly wantsStream: boolean;
    readonly entries: readonly MultipartField[];
  }
  | { readonly type: 'invalid'; readonly message: string };

const prepareOpenAIAudioTranscription = async (
  bytes: Uint8Array,
  contentType: string | undefined,
): Promise<PreparedOpenAIAudioTranscription> => {
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

  const entries: MultipartField[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      entries.push({ kind: 'text', name, value });
    } else {
      entries.push({
        kind: 'file',
        name,
        bytes: new Uint8Array(await value.arrayBuffer()),
        filename: value.name,
        contentType: value.type,
      });
    }
  }
  return {
    type: 'ok',
    model,
    wantsStream: form.get('stream') === 'true',
    entries,
  };
};

export const openaiAudioTranscriptions = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = await prepareOpenAIAudioTranscription(requestBody.bytes, c.req.header('content-type'));
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: request.type === 'ok' ? request.wantsStream : false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, Response.json(
      { error: { message: request.message, type: 'api_error' } },
      { status: 400 },
    ));
  }

  const services = createGatewayPipelineServices(ctx);
  services.attribution.recordRequestedModel(request.model);
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  return await runGatewayHttpPipeline(c, ctx, openaiAudioTranscriptionsPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaders,
      body: { kind: 'multipart', parts: request.entries },
      protocol: 'openai-audio-transcriptions',
    },
    'request.inboundHeaders': inboundHeaders,
    'request.model': request.model,
    'request.entries': request.entries,
  }, { services });
};
