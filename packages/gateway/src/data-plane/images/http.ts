// POST /v1/images/generations and POST /v1/images/edits — route image
// requests to the provider that declares the requested model and the
// matching image endpoint capability.
//
// The edits handler accepts multipart uploads and JSON `images` references.
// Both are buffered once for dump capture and normalized into a semantic
// request; each provider owns the final JSON or multipart serialization.
// Streaming requests retain the upstream SSE wire and settle only after the
// endpoint-specific completed event followed by EOF.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L12558-L12620

import type { Context } from 'hono';

import { respondImages } from './respond.ts';
import { MAX_BUFFERED_REQUEST_BODY_BYTES } from '../../middleware/request-body-limit.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { createGatewayCtxFromHono, finalizeGatewayResponse } from '../shared/gateway-ctx.ts';
import { multipartLimitMessage, parseMultipartEntries, singleNonEmptyMultipartTextEntry } from '../shared/multipart.ts';
import { prepareJsonModelRequest } from '../shared/passthrough-request.ts';
import { passthroughApiError, passthroughServe } from '../shared/passthrough-serve.ts';
import { completeRequestBodyBytes, readRequestBody, takeRequestBody, type RequestBody } from '../shared/request-body.ts';
import { isJsonMediaType, isMultipartFormDataMediaType } from '@floway-dev/protocols/common';
import type { ImageEditReference } from '@floway-dev/protocols/images';
import { isBase64ImageDataUrl, type ImagesEditsRequest, type ImagesEditsSource, type RawImagesEditsUpload } from '@floway-dev/provider';

type PreparedImagesEdit =
  | { type: 'ok'; request: ImagesEditsRequest }
  | { type: 'invalid'; message: string };

// OpenAI bounds both the JSON `images` array and multipart `image` array at
// sixteen inputs.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L47542-L47673
export const MAX_IMAGE_EDIT_INPUTS = 16;

// The upstream accepts each GPT-image edit source below 50 MB, as many as 16
// sources, and a PNG mask below 4 MB. Floway keeps a separate aggregate wire
// budget because parsing, dump capture, and outbound framing can coexist. The
// 52 MiB fixed-length aggregate admits one maximum image plus multipart
// framing, or up to sixteen smaller images; an undeclared/chunked body keeps
// the general 26 MiB ceiling because its retained chunks overlap the one final
// coalesced buffer. Floway deliberately does not promise the upstream's
// theoretical 16 × 50 MB aggregate inside a 128 MB Worker isolate.
// https://github.com/openai/openai-openapi/blob/a3276900e58b8b2a92e0cb087cd2e6e005f58458/openapi.yaml#L44745-L44790
// https://github.com/cloudflare/cloudflare-docs/blob/f8ac0aa6d9ef268d442865225c786753aa1332af/src/content/docs/workers/platform/limits.mdx#L119-L127
export const MAX_IMAGE_EDIT_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_EDIT_MASK_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES = 52 * 1024 * 1024;
export const MAX_IMAGE_EDIT_UNDECLARED_MULTIPART_BODY_BYTES = MAX_BUFFERED_REQUEST_BODY_BYTES;

export const imageEditUploadSizeError = (
  file: Pick<File, 'size'>,
  kind: 'image' | 'mask',
  maxBytes = kind === 'image' ? MAX_IMAGE_EDIT_FILE_BYTES : MAX_IMAGE_EDIT_MASK_BYTES,
): string | null => file.size >= maxBytes
  ? `Image edits ${kind} file must be smaller than ${maxBytes} bytes.`
  : null;

const imageEditSource = (value: unknown, path: string): ImagesEditsSource | string => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return `${path} must be an object.`;
  }
  const reference = value as { image_url?: unknown; file_id?: unknown };
  const { image_url: imageUrl, file_id: fileId } = reference;
  if (typeof imageUrl === 'string' && fileId === undefined) {
    const imageReference = reference as ImageEditReference & { image_url: string };
    return isBase64ImageDataUrl(imageUrl)
      ? { type: 'inline', reference: imageReference }
      : { type: 'reference', reference: imageReference };
  }
  if (typeof fileId === 'string' && imageUrl === undefined) {
    return { type: 'reference', reference: reference as ImageEditReference };
  }
  return `${path} must contain exactly one string field: image_url or file_id.`;
};

const prepareJsonImagesEdit = (body: Record<string, unknown>): PreparedImagesEdit => {
  if (!Array.isArray(body.images)) {
    return { type: 'invalid', message: 'Image edits request body must include an images array.' };
  }
  if (body.images.length === 0) {
    return { type: 'invalid', message: 'Image edits request body must include at least one image.' };
  }
  if (body.images.length > MAX_IMAGE_EDIT_INPUTS) {
    return { type: 'invalid', message: `Image edits request body supports at most ${MAX_IMAGE_EDIT_INPUTS} images.` };
  }
  const images: ImagesEditsSource[] = [];
  for (const [index, value] of body.images.entries()) {
    const source = imageEditSource(value, `Image edits images[${index}]`);
    if (typeof source === 'string') return { type: 'invalid', message: source };
    images.push(source);
  }
  let mask: ImagesEditsSource | undefined;
  if (body.mask !== undefined) {
    const source = imageEditSource(body.mask, 'Image edits mask');
    if (typeof source === 'string') return { type: 'invalid', message: source };
    mask = source;
  }
  const { model: _model, images: _images, mask: _mask, ...parameters } = body;
  return {
    type: 'ok',
    request: {
      images,
      ...(mask === undefined ? {} : { mask }),
      parameters,
    },
  };
};

export const imagesGenerations = async (c: Context): Promise<Response> => {
  const requestBody = await readRequestBody(c);
  const request = prepareJsonModelRequest(completeRequestBodyBytes(requestBody), 'Images generations');
  const wantsStream = request.type === 'ok' && request.body.stream === true;
  const ctx = createGatewayCtxFromHono(c, { wantsStream, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  if (request.type === 'invalid') {
    ctx.dump?.error('gateway');
    return finalizeGatewayResponse(ctx, passthroughApiError(c, request.message, 400));
  }

  ctx.dump?.requestedModel(request.model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/generations',
    operation: 'image_generation',
    model: request.model,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesGenerations !== undefined,
    call: (provider, model, opts) => {
      const { model: _model, ...body } = request.body;
      return provider.instance.callImagesGenerations(model, body, ctx.executionSignal, opts);
    },
    response: { format: 'strategy', respond: respondImages },
  });
  return finalizeGatewayResponse(ctx, response);
};

const serveImagesEditRequest = async (
  c: Context,
  requestBody: RequestBody,
  model: string,
  request: ImagesEditsRequest,
  wantsStream: boolean,
): Promise<Response> => {
  const ctx = createGatewayCtxFromHono(c, { wantsStream, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
  ctx.dump?.requestedModel(model);
  const response = await passthroughServe({
    c,
    ctx,
    sourceApi: '/images/edits',
    operation: 'image_edit',
    model,
    kind: 'image',
    modelServesEndpoint: model => model.endpoints.imagesEdits !== undefined,
    call: (provider, model, opts) => provider.instance.callImagesEdits(model, request, ctx.executionSignal, opts),
    response: { format: 'strategy', respond: respondImages },
  });
  return finalizeGatewayResponse(ctx, response);
};

export const imagesEdits = async (c: Context): Promise<Response> => {
  const contentType = c.req.header('content-type');
  const requestBody = await readRequestBody(c, isMultipartFormDataMediaType(contentType)
    ? {
        maxBytes: MAX_IMAGE_EDIT_MULTIPART_BODY_BYTES,
        maxBytesWithoutContentLength: MAX_IMAGE_EDIT_UNDECLARED_MULTIPART_BODY_BYTES,
      }
    : {});
  const invalid = (message: string): Response => {
    const errorCtx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody: takeRequestBody(requestBody), backgroundScheduler: backgroundSchedulerFromContext(c) });
    errorCtx.dump?.error('gateway');
    return finalizeGatewayResponse(errorCtx, passthroughApiError(c, message, 400));
  };

  if (contentType === undefined) {
    return invalid('Image edits request body must use application/json or multipart/form-data.');
  }
  if (isJsonMediaType(contentType)) {
    const body = prepareJsonModelRequest(completeRequestBodyBytes(requestBody), 'Image edits');
    if (body.type === 'invalid') return invalid(body.message);
    const request = prepareJsonImagesEdit(body.body);
    if (request.type === 'invalid') return invalid(request.message);
    return await serveImagesEditRequest(c, requestBody, body.model, request.request, body.body.stream === true);
  }

  if (!isMultipartFormDataMediaType(contentType)) {
    return invalid('Image edits request body must use application/json or multipart/form-data.');
  }
  const parsed = parseMultipartEntries(completeRequestBodyBytes(requestBody), contentType);
  if (parsed.type === 'invalid') {
    return invalid('Image edits request body must be valid multipart/form-data.');
  }
  if (parsed.type === 'limit') return invalid(multipartLimitMessage(parsed));
  const { entries } = parsed;
  const model = singleNonEmptyMultipartTextEntry(entries, 'model');
  if (model === undefined) {
    return invalid('Image edits request body must include a model field.');
  }
  const images: RawImagesEditsUpload[] = [];
  let mask: RawImagesEditsUpload | undefined;
  const parameters: Record<string, string | number | boolean> = {};
  const parameterNames = new Set<string>();
  for (const { name, value } of entries) {
    if (name === 'model') continue;
    if (name === 'image' || name === 'image[]') {
      if (typeof value === 'string') return invalid(`Image edits ${name} fields must be files.`);
      const sizeError = imageEditUploadSizeError({ size: value.bytes.byteLength }, 'image');
      if (sizeError !== null) return invalid(sizeError);
      images.push(value);
    } else if (name === 'mask') {
      if (typeof value === 'string') return invalid('Image edits mask field must be a file.');
      if (mask !== undefined) return invalid('Image edits request body supports at most one mask file.');
      const sizeError = imageEditUploadSizeError({ size: value.bytes.byteLength }, 'mask');
      if (sizeError !== null) return invalid(sizeError);
      mask = value;
    } else {
      if (typeof value !== 'string') return invalid(`Image edits ${name} field must be text.`);
      if (parameterNames.has(name)) return invalid(`Image edits ${name} field must appear at most once.`);
      parameterNames.add(name);
      parameters[name] = value;
    }
  }
  if (images.length === 0) {
    return invalid('Image edits request body must include at least one image file.');
  }
  if (images.length > MAX_IMAGE_EDIT_INPUTS) {
    return invalid(`Image edits request body supports at most ${MAX_IMAGE_EDIT_INPUTS} images.`);
  }
  return await serveImagesEditRequest(c, requestBody, model, {
    images: images.map(upload => ({ type: 'raw-upload', upload })),
    ...(mask === undefined ? {} : { mask: { type: 'raw-upload' as const, upload: mask } }),
    parameters,
  }, parameters.stream === 'true');
};
