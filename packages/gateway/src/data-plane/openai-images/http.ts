// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// The edits handler accepts multipart uploads and JSON `images` references.
// Both are buffered once for dump capture and normalized into a semantic
// request; each provider owns the final JSON or multipart serialization.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620

import type { Context } from 'hono';

import { openaiImagesEditsPipeline, openaiImagesGenerationsPipeline } from './pipeline.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import {
  buildDownstreamWireUrl,
  createGatewayPipelineServices,
  inboundHeaderEntriesFromHono,
  runGatewayHttpPipeline,
} from '../pipeline/index.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { readRequestBody, takeRequestBody, type RequestBody } from '../shared/request-body.ts';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { OpenAIImageEditReference } from '@floway-dev/protocols/openai-images';
import { isBase64ImageDataUrl } from '@floway-dev/provider';
import type {
  ImageEditPartSource,
  ImageEditsPipelineRequest,
  MultipartField,
} from '@floway-dev/provider';

type PreparedOpenAIImagesEdit =
  | {
    readonly type: 'ok';
    readonly model: string;
    readonly request: ImageEditsPipelineRequest;
    readonly httpBody:
      | { readonly kind: 'json'; readonly value: Record<string, unknown> }
      | { readonly kind: 'multipart'; readonly parts: readonly MultipartField[] };
  }
  | { readonly type: 'invalid'; readonly message: string };

const openaiImageEditSource = (value: unknown, path: string): ImageEditPartSource | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const reference = value as { image_url?: unknown; file_id?: unknown };
  const { image_url: imageUrl, file_id: fileId } = reference;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const imageReference = reference as OpenAIImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl)
      ? { type: 'inline', reference: imageReference }
      : { type: 'reference', reference: imageReference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: reference as OpenAIImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const prepareJsonOpenAIImagesEdit = (body: Record<string, unknown>, model: string): PreparedOpenAIImagesEdit => {
  if (!Array.isArray(body.images)) {
    return { type: 'invalid', message: 'OpenAI Images Edits request body must include an images array.' };
  }
  const images: ImageEditPartSource[] = [];
  for (const [index, value] of body.images.entries()) {
    const source = openaiImageEditSource(value, `OpenAI Images Edits images[${index}]`);
    if (typeof source === 'string') return { type: 'invalid', message: source };
    images.push(source);
  }
  let mask: ImageEditPartSource | undefined;
  if (body.mask !== undefined) {
    const source = openaiImageEditSource(body.mask, 'OpenAI Images Edits mask');
    if (typeof source === 'string') return { type: 'invalid', message: source };
    mask = source;
  }
  const { model: _model, images: _images, mask: _mask, ...parameters } = body;
  return {
    type: 'ok',
    model,
    request: {
      images,
      ...(mask === undefined ? {} : { mask }),
      parameters,
    },
    httpBody: { kind: 'json', value: body },
  };
};

export const openaiImagesGenerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Images Generations');
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
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
  const { model: _model, ...payload } = request.body;
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  return await runGatewayHttpPipeline(c, ctx, openaiImagesGenerationsPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaders,
      body: { kind: 'json', value: request.body },
      protocol: 'openai-images-generations',
    },
    'request.inboundHeaders': inboundHeaders,
    'request.model': request.model,
    'request.payload': payload,
  }, { services });
};

const serveOpenAIImagesEditRequest = async (
  c: Context,
  requestBody: RequestBody,
  request: PreparedOpenAIImagesEdit & { readonly type: 'ok' },
): Promise<Response> => {
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  const services = createGatewayPipelineServices(ctx);
  services.attribution.recordRequestedModel(request.model);
  const inboundHeaders = inboundHeaderEntriesFromHono(c);
  return await runGatewayHttpPipeline(c, ctx, openaiImagesEditsPipeline, {
    'request.http': {
      method: c.req.method,
      url: buildDownstreamWireUrl(c.req.url),
      headers: inboundHeaders,
      body: request.httpBody,
      protocol: 'openai-images-edits',
    },
    'request.inboundHeaders': inboundHeaders,
    'request.model': request.model,
    'request.payload': request.request,
  }, { services });
};

const invalidImagesEdit = (
  c: Context,
  requestBody: RequestBody,
  message: string,
): Response => {
  const ctx = createGatewayCtxFromHono(c, {
    wantsStream: false,
    requestBody: takeRequestBody(requestBody),
    backgroundScheduler: backgroundSchedulerFromContext(c),
  });
  ctx.dump?.error('gateway');
  return finalizeGatewayResponse(ctx, Response.json(
    { error: { message, type: 'api_error' } },
    { status: 400 },
  ));
};

const multipartImageEdit = async (
  requestBody: RequestBody,
  contentType: string,
): Promise<PreparedOpenAIImagesEdit> => {
  let form: FormData;
  try {
    form = await new Response(requestBody.bytes as BodyInit, { headers: { 'content-type': contentType } }).formData();
  } catch {
    return { type: 'invalid', message: 'OpenAI Images Edits request body must be valid multipart/form-data.' };
  }
  const model = form.get('model');
  if (typeof model !== 'string' || model.length === 0) {
    return { type: 'invalid', message: 'OpenAI Images Edits request body must include a model field.' };
  }

  const images: ImageEditPartSource[] = [];
  const parts: MultipartField[] = [];
  let mask: ImageEditPartSource | undefined;
  for (const [name, value] of form.entries()) {
    if (name === 'model') {
      parts.push({ kind: 'text', name, value: model });
    } else if (name === 'image' || name === 'image[]') {
      if (!(value instanceof File)) return { type: 'invalid', message: `OpenAI Images Edits ${name} fields must be files.` };
      const source = {
        type: 'upload',
        bytes: new Uint8Array(await value.arrayBuffer()),
        filename: value.name,
        contentType: value.type,
      } satisfies ImageEditPartSource;
      images.push(source);
      parts.push({
        kind: 'file',
        name,
        bytes: source.bytes,
        filename: source.filename,
        contentType: source.contentType,
      });
    } else if (name === 'mask') {
      if (!(value instanceof File)) return { type: 'invalid', message: 'OpenAI Images Edits mask field must be a file.' };
      const source = {
        type: 'upload',
        bytes: new Uint8Array(await value.arrayBuffer()),
        filename: value.name,
        contentType: value.type,
      } satisfies ImageEditPartSource;
      mask = source;
      parts.push({
        kind: 'file',
        name,
        bytes: source.bytes,
        filename: source.filename,
        contentType: source.contentType,
      });
    } else {
      if (typeof value !== 'string') return { type: 'invalid', message: `OpenAI Images Edits ${name} field must be text.` };
      parts.push({ kind: 'text', name, value });
    }
  }

  return {
    type: 'ok',
    model,
    request: {
      images,
      ...(mask === undefined ? {} : { mask }),
      parameters: Object.fromEntries(
        parts
          .filter((part): part is Extract<MultipartField, { kind: 'text' }> =>
            part.kind === 'text' && part.name !== 'model')
          .map(part => [part.name, part.value]),
      ),
    },
    httpBody: { kind: 'multipart', parts },
  };
};

export const openaiImagesEdits = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const contentType = c.req.header('content-type');
  if (contentType === undefined) {
    return invalidImagesEdit(
      c,
      requestBody,
      'OpenAI Images Edits request body must use application/json or multipart/form-data.',
    );
  }

  if (isJsonMediaType(contentType)) {
    const body = prepareJsonModelRequest(requestBody.bytes, 'OpenAI Images Edits');
    if (body.type === 'invalid') return invalidImagesEdit(c, requestBody, body.message);
    const request = prepareJsonOpenAIImagesEdit(body.body, body.model);
    if (request.type === 'invalid') return invalidImagesEdit(c, requestBody, request.message);
    return await serveOpenAIImagesEditRequest(c, requestBody, request);
  }

  if (!isMultipartFormDataMediaType(contentType)) {
    return invalidImagesEdit(
      c,
      requestBody,
      'OpenAI Images Edits request body must use application/json or multipart/form-data.',
    );
  }
  const request = await multipartImageEdit(requestBody, contentType);
  if (request.type === 'invalid') return invalidImagesEdit(c, requestBody, request.message);
  return await serveOpenAIImagesEditRequest(c, requestBody, request);
};
