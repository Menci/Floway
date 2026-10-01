import { portableImageRequest, type ImageBackendConfig } from './image-sub-request/request.ts';
import { imageTerminal, isRetryableImageError, serverError } from './image-sub-request/result.ts';
import { runImageGenerationSubRequest } from './image-sub-request.ts';
import type { HostedToolLifecycleEvent, HostedToolRegistration, HostedToolTerminal } from './types.ts';
import type { GatewayCtx } from '../../../shared/gateway-ctx.ts';
import { createExternalImageFetcher, type ExternalImageFetchResult } from '../../shared/external-image-loader.ts';
import { dimensionsFromBytes } from '@floway-dev/platform';
import { decodeForgivingBase64, isImageMediaType, mediaTypeEssence } from '@floway-dev/protocols/common';
import {
  collectOpenAIResponsesToolEntries,
  createRandomOpenAIResponsesItemId,
  type OpenAIResponsesFunctionCallOutputItem,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesFunctionToolCallItem,
  type OpenAIResponsesHostedTool,
  type OpenAIResponsesInputImage,
  type OpenAIResponsesInputImageGenerationCall,
  type OpenAIResponsesInputItem,
  type OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';
import { providerModelOf } from '@floway-dev/provider';

export const FUNCTION_TOOL_NAME = 'image_generation';

// Default image backend when the hosted tool omits `model`. gpt-image-2 is
// the reference backend Azure's native OpenAI Responses `image_generation` routes
// to; operators provision it under this public id (or alias it).
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

// Safety valve on the multi-turn ReAct loop: cap how many real image backend
// calls one response may dispatch (counted on `HostedToolState.imageDispatchCount`,
// not the shared ReAct turn count, so unrelated turns do not consume the
// budget). Past the cap the dispatcher replays an exhausted-budget tool output
// instead of hitting the backend, so a model that keeps retrying after failures
// cannot drive unbounded image cost.
const IMAGE_ITERATION_CAP = 10;

// Public OpenAI Responses `image_generation` tool config enums (Azure-strict
// surface). `webp` and arbitrary `WxH` sizes are rejected because the
// native Azure path rejects them; the dispatcher mirrors that vocabulary rather
// than passing them to a backend that would 400 with a different shape.
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpeg']);
const ALLOWED_MODERATIONS = new Set(['auto', 'low']);
const ALLOWED_ACTIONS = new Set(['generate', 'edit', 'auto']);
const ALLOWED_INPUT_FIDELITY = new Set(['high', 'low']);

// The public `image_generation` tool-config surface. Azure rejects any other
// field with `unknown_parameter`, so the dispatcher mirrors that strictness rather
// than silently forwarding unknown fields (which would diverge from the
// emulated surface and hide client bugs). `n` is deliberately absent: Azure
// echoes `n:1` internally but rejects a client-supplied `tools[].n`.
const KNOWN_TOOL_FIELDS = new Set([
  'type', 'model', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation', 'partial_images', 'input_fidelity',
  'input_image_mask', 'action',
]);

export const isHostedImageGenerationTool = (tool: OpenAIResponsesTool): tool is OpenAIResponsesHostedTool =>
  tool.type === 'image_generation';

// Identity canonicalization for image_generation: the dispatcher doesn't
// depend on filled defaults to run, and the OpenAI spec defaults for
// `background` / `quality` / `size` / etc. observed via Azure echo
// (all `'auto'`) signal "backend decides" rather than concrete values
// the model needs. Preserving the client's raw shape keeps the echo
// round-trip minimal — anything the client didn't send stays absent.
export const canonicalizeImageGenerationTool = (raw: OpenAIResponsesTool): OpenAIResponsesHostedTool | undefined =>
  isHostedImageGenerationTool(raw) ? raw : undefined;

interface ImageSource {
  bytes: ArrayBuffer;
  mimeType: string;
}

interface RemoteImageSource {
  wireUrl: string;
  invalidUrlParam: string;
  afterMaterializationError?: PrepareConfigError;
}

type ImageSourceReference = ImageSource | RemoteImageSource;

const isRemoteImageSource = (source: ImageSourceReference): source is RemoteImageSource =>
  'wireUrl' in source;

const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
  const bytes = decodeForgivingBase64(b64);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

// Parse a `data:<mime>;base64,<payload>` URL or a bare base64 string (as
// emitted in `image_generation_call.result`) into raw bytes. Remote URLs are
// materialized at request preparation and therefore stay outside this decoder.
const decodeInlineImage = (
  imageUrl: string,
  fallbackMime = 'image/png',
  cache?: Map<string, ImageSource | null>,
): ImageSource | null => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  let payload: string;
  let mimeType: string;
  if (dataUrlMatch === null) {
    if (/^https?:\/\//i.test(imageUrl)) return null;
    payload = imageUrl;
    mimeType = fallbackMime;
  } else {
    if (dataUrlMatch[2] === undefined) return null;
    payload = dataUrlMatch[3];
    mimeType = dataUrlMatch[1] ?? fallbackMime;
  }

  // A generated result is bare base64 on its first appearance and a data URL
  // after the hosted-tool replay transform. Keying by decoded wire identity
  // lets both representations reuse the same bytes on later ReAct turns.
  const cacheKey = `${mimeType}\u0000${payload}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey) ?? null;

  let decoded: ImageSource | null;
  try {
    decoded = { bytes: base64ToArrayBuffer(payload), mimeType };
  } catch {
    decoded = null;
  }
  cache?.set(cacheKey, decoded);
  return decoded;
};

type InputImageDecodeResult =
  | { ok: true; source: ImageSource }
  | {
    ok: false;
    reason: 'invalid_format' | 'missing_base64_separator' | 'unsupported_mime' | 'invalid_base64';
    mimeType?: string;
  };

// OpenAI Responses input_image.image_url is stricter than an internal replayed
// image_generation_call.result: it must be a fully qualified URL or an image
// data URL. Bare base64 remains valid only for the internal replay path.
const decodeInputImageDataUrl = (
  imageUrl: string,
  decodedSources: Map<string, ImageSource | null>,
): InputImageDecodeResult => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (dataUrlMatch === null) return { ok: false, reason: 'invalid_format' };

  const suppliedMimeType = dataUrlMatch[1] ?? '';
  const mimeType = mediaTypeEssence(suppliedMimeType);
  if (!isImageMediaType(mimeType) || mimeType === null) {
    return { ok: false, reason: 'unsupported_mime', mimeType: suppliedMimeType };
  }
  if (dataUrlMatch[2] === undefined) return { ok: false, reason: 'missing_base64_separator' };

  const payload = dataUrlMatch[3];
  const cacheKey = `${mimeType}\u0000${payload}`;
  if (decodedSources.has(cacheKey)) {
    const source = decodedSources.get(cacheKey);
    return source === null || source === undefined
      ? { ok: false, reason: 'invalid_base64' }
      : { ok: true, source };
  }

  try {
    const source = { bytes: base64ToArrayBuffer(payload), mimeType };
    decodedSources.set(cacheKey, source);
    return { ok: true, source };
  } catch {
    decodedSources.set(cacheKey, null);
    return { ok: false, reason: 'invalid_base64' };
  }
};

// The orchestrator-visible tool config the dispatcher layers onto the backend
// call. Mirrors Azure: the orchestrator only chooses `prompt`; everything
// here is read from the client's hosted-tool entry and applied by the dispatcher.
export interface ImageGenerationConfig extends ImageBackendConfig {
  mask?: ImageSourceReference;
}

type MaterializedImageGenerationConfig = Omit<ImageGenerationConfig, 'mask'> & { mask?: ImageSource };

interface PrepareConfigError {
  message: string;
  param: string;
  code: 'unknown_parameter' | 'invalid_value' | 'integer_below_min_value' | 'integer_above_max_value' | 'unsupported_image_source';
}

type PrepareConfigResult =
  | { ok: true; config: ImageGenerationConfig }
  | { ok: false; error: PrepareConfigError };

const invalidValue = (param: string, value: unknown, allowed: Iterable<string>): PrepareConfigError => ({
  message: `Invalid value: ${JSON.stringify(value)}. Supported values are: ${[...allowed].map(v => `'${v}'`).join(', ')}.`,
  param,
  code: 'invalid_value',
});

// Integer range check that mirrors Azure's distinct out-of-range codes
// (`integer_below_min_value` / `integer_above_max_value`) rather than
// collapsing them into a generic `invalid_value`.
const integerInRange = (value: unknown, param: string, min: number, max: number): PrepareConfigError | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { message: `Invalid value: ${JSON.stringify(value)}. Expected an integer in [${min}, ${max}].`, param, code: 'invalid_value' };
  }
  if (value < min) return { message: `Invalid value: ${value}. Expected an integer >= ${min}.`, param, code: 'integer_below_min_value' };
  if (value > max) return { message: `Invalid value: ${value}. Expected an integer <= ${max}.`, param, code: 'integer_above_max_value' };
  return null;
};

// Validate one hosted `image_generation` declaration against the fields and
// values supported by this dispatcher. The caller validates every
// declaration before selecting the last config, so an earlier invalid entry
// fails. toolPath identifies its source carrier in the error.
// https://developers.openai.com/api/docs/guides/tools-image-generation
const validateHostedImageGenerationEntry = (
  tool: OpenAIResponsesHostedTool,
  toolPath: string,
): { ok: true; config: ImageGenerationConfig } | { ok: false; error: PrepareConfigError } => {
  const path = (field: string): string => `${toolPath}.${field}`;

  // Reject any field outside the public surface (Azure-strict). This
  // subsumes `n` (absent from KNOWN_TOOL_FIELDS) and any typo'd / unsupported
  // field. First unknown key wins so the envelope names one offender.
  for (const key of Object.keys(tool)) {
    if (!KNOWN_TOOL_FIELDS.has(key) && (tool as Record<string, unknown>)[key] !== undefined) {
      return { ok: false, error: { message: `Unknown parameter: '${path(key)}'.`, param: path(key), code: 'unknown_parameter' } };
    }
  }

  const modelRaw = tool.model;
  if (modelRaw !== undefined && modelRaw !== null && (typeof modelRaw !== 'string' || modelRaw.length === 0)) {
    return { ok: false, error: { message: `Invalid value: ${JSON.stringify(modelRaw)}. Expected a non-empty model id.`, param: path('model'), code: 'invalid_value' } };
  }
  const size = tool.size;
  if (size !== undefined && size !== null && (typeof size !== 'string' || !ALLOWED_SIZES.has(size))) {
    return { ok: false, error: invalidValue(path('size'), size, ALLOWED_SIZES) };
  }
  const quality = tool.quality;
  if (quality !== undefined && quality !== null && (typeof quality !== 'string' || !ALLOWED_QUALITIES.has(quality))) {
    return { ok: false, error: invalidValue(path('quality'), quality, ALLOWED_QUALITIES) };
  }
  const background = tool.background;
  if (background !== undefined && background !== null && (typeof background !== 'string' || !ALLOWED_BACKGROUNDS.has(background))) {
    return { ok: false, error: invalidValue(path('background'), background, ALLOWED_BACKGROUNDS) };
  }
  const outputFormat = tool.output_format;
  if (outputFormat !== undefined && outputFormat !== null && (typeof outputFormat !== 'string' || !ALLOWED_OUTPUT_FORMATS.has(outputFormat))) {
    return { ok: false, error: invalidValue(path('output_format'), outputFormat, ALLOWED_OUTPUT_FORMATS) };
  }
  const moderation = tool.moderation;
  if (moderation !== undefined && moderation !== null && (typeof moderation !== 'string' || !ALLOWED_MODERATIONS.has(moderation))) {
    return { ok: false, error: invalidValue(path('moderation'), moderation, ALLOWED_MODERATIONS) };
  }
  const action = tool.action;
  if (action !== undefined && action !== null && (typeof action !== 'string' || !ALLOWED_ACTIONS.has(action))) {
    return { ok: false, error: invalidValue(path('action'), action, ALLOWED_ACTIONS) };
  }
  const inputFidelity = tool.input_fidelity;
  if (inputFidelity !== undefined && inputFidelity !== null && (typeof inputFidelity !== 'string' || !ALLOWED_INPUT_FIDELITY.has(inputFidelity))) {
    return { ok: false, error: invalidValue(path('input_fidelity'), inputFidelity, ALLOWED_INPUT_FIDELITY) };
  }
  const compressionError = integerInRange(tool.output_compression, path('output_compression'), 0, 100);
  if (compressionError !== null) return { ok: false, error: compressionError };
  const partialError = integerInRange(tool.partial_images, path('partial_images'), 0, 3);
  if (partialError !== null) return { ok: false, error: partialError };

  // The published OpenAI and Azure schemas make `image_url` and `file_id`
  // independently optional and define no mutual-exclusivity error. Floway
  // cannot resolve a file ID in its owning upstream's Files namespace, so we
  // validate a supplied image URL first and then report `file_id` as Floway's
  // unsupported source instead of silently choosing a field or inventing a
  // native 400 envelope.
  // https://github.com/openai/openai-openapi/blob/5162af98d3147432c14680df789e8e12d4891e6b/openapi.yaml#L51524-L51539
  // https://github.com/Azure/azure-rest-api-specs/blob/bc54681a2af2c09a6254ce9a57fdb78d71d04eba/specification/ai/data-plane/OpenAI.v1/azure-v1-v1-generated.yaml#L19479-L19505
  const maskField = tool.input_image_mask;
  let mask: ImageSourceReference | undefined;
  if (maskField !== undefined && maskField !== null) {
    if (typeof maskField !== 'object' || Array.isArray(maskField)) {
      return { ok: false, error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']) };
    }
    const maskInput = maskField as { image_url?: unknown; file_id?: unknown };
    const fileIdError: PrepareConfigError | null = typeof maskInput.file_id === 'string' && maskInput.file_id.length > 0
      ? {
          message: 'Floway cannot resolve input_image_mask.file_id; remove file_id and provide image_url alone.',
          param: path('input_image_mask.file_id'),
          code: 'unsupported_image_source',
        }
      : null;
    const maskUrl = maskInput.image_url;
    if (typeof maskUrl !== 'string' || maskUrl.length === 0) {
      if (fileIdError !== null) return { ok: false, error: fileIdError };
      return {
        ok: false,
        error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']),
      };
    }
    if (/^https?:\/\//i.test(maskUrl)) {
      mask = {
        wireUrl: maskUrl,
        invalidUrlParam: path('input_image_mask.image_url'),
        ...(fileIdError === null ? {} : { afterMaterializationError: fileIdError }),
      };
    } else {
      const decodedMask = decodeInlineImage(maskUrl);
      if (decodedMask === null) {
        return {
          ok: false,
          error: { message: 'image_generation input_image_mask.image_url must contain valid base64 image data.', param: path('input_image_mask.image_url'), code: 'invalid_value' },
        };
      }
      mask = decodedMask;
      if (fileIdError !== null) return { ok: false, error: fileIdError };
    }
  }

  return {
    ok: true,
    config: {
      model: typeof modelRaw === 'string' && modelRaw.length > 0 ? modelRaw : DEFAULT_IMAGE_MODEL,
      ...(typeof size === 'string' ? { size } : {}),
      ...(typeof quality === 'string' ? { quality } : {}),
      ...(typeof outputFormat === 'string' ? { output_format: outputFormat as 'png' | 'jpeg' } : {}),
      ...(typeof background === 'string' ? { background: background as ImageGenerationConfig['background'] } : {}),
      ...(typeof moderation === 'string' ? { moderation: moderation as 'auto' | 'low' } : {}),
      ...(typeof tool.output_compression === 'number' ? { output_compression: tool.output_compression } : {}),
      ...(typeof tool.partial_images === 'number' ? { partial_images: tool.partial_images } : {}),
      ...(typeof inputFidelity === 'string' ? { input_fidelity: inputFidelity as 'high' | 'low' } : {}),
      ...(mask !== undefined ? { mask } : {}),
      action: (typeof action === 'string' ? action : 'auto') as ImageGenerationConfig['action'],
    },
  };
};

// Validate every hosted `image_generation` entry; the last one in the
// collected declaration order supplies the active config.
export const prepareImageGenerationConfig = (
  tools: readonly OpenAIResponsesTool[],
  paths: readonly string[] = tools.map((_, index) => `tools[${index}]`),
): PrepareConfigResult => {
  let config: ImageGenerationConfig | undefined;
  for (const [i, tool] of tools.entries()) {
    if (!isHostedImageGenerationTool(tool)) continue;
    const validated = validateHostedImageGenerationEntry(tool, paths[i]);
    if (!validated.ok) return validated;
    config = validated.config;
  }
  if (config === undefined) return { ok: false, error: { message: 'No image_generation tool present.', param: 'tools', code: 'unknown_parameter' } };
  return { ok: true, config };
};

// Single optional `prompt` parameter — matches the native `image_gen.imagegen`
// tool's surface (size/quality/etc. are NOT model-chosen; the dispatcher layers them
// on from the client config, exactly like Azure). A minimal description
// elicits native-quality refined prompts while costing ~50 input tokens vs
// the native hosted tool's ~2300.
export const buildImageGenerationFunctionTool = (_canonical: OpenAIResponsesHostedTool, name: string): OpenAIResponsesFunctionTool => ({
  type: 'function',
  name,
  description:
    'Generate an image from a text description, or edit an attached image per instructions. '
    + 'Use it whenever the user asks for a picture, drawing, illustration, photo, diagram, or any visual, '
    + 'or wants to modify an attached image. Generate directly without asking for confirmation, '
    + 'and do not describe or comment on the image after generating it.',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Detailed description of the image to generate or the edit to perform.' },
    },
    // Even `prompt` is optional on the native tool; the orchestrator may
    // call with no args and let the backend auto-prompt.
    required: [],
    additionalProperties: false,
  },
  // `strict: true` would require `required` to list every property; `prompt`
  // is intentionally optional, so the tool is non-strict.
  strict: false,
});

export const synthesizeImageGenerationCallId = (): string =>
  createRandomOpenAIResponsesItemId('image_generation_call');

// Collect all image sources from the request input in forward declaration
// order: inline/remote `input_image` blocks in messages and function/custom
// tool outputs, and full-echo
// `image_generation_call` items carrying `result` bytes, each in the order they
// appear. Order is load-bearing: probing both the standalone /images/edits
// endpoint and native OpenAI Responses showed gpt-image numbers the attached images
// positionally — a prompt that says "the first/second/last image" resolves
// against the order received — and native flattens every image across messages
// and tool results into this same forward order. Preserving declaration order
// therefore makes "the Nth image" mean the same thing here as it does natively.
interface InputImageEntry {
  image: OpenAIResponsesInputImage;
  path: string;
}

const inputImagesOf = (item: OpenAIResponsesInputItem, inputIndex: number): InputImageEntry[] => {
  const content = item.type === 'message'
    ? item.content
    : item.type === 'function_call_output' || item.type === 'custom_tool_call_output' ? item.output : undefined;
  if (!Array.isArray(content)) return [];
  const field = item.type === 'message' ? 'content' : 'output';
  return content.flatMap((block, contentIndex) => block.type === 'input_image'
    ? [{ image: block, path: `input[${inputIndex}].${field}[${contentIndex}]` }]
    : []);
};

interface ImageOperationError {
  message: string;
  errorType: string;
  param: string | null;
  code: string | null;
}

type RemoteImageFailure =
  | Exclude<ExternalImageFetchResult, { type: 'success' }>
  | { type: 'invalid-image' }
  | { type: 'aggregate-too-large' };

const INVALID_REMOTE_IMAGE_MESSAGE = "The image data you provided does not represent a valid image. Please check your input and try again with one of the supported image formats: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].";
const REMOTE_IMAGE_TIMEOUT_MESSAGE = 'Unable to download content from the provided URL before the timeout. Check that the URL is publicly accessible and responds promptly, or upload the file and provide a file_id instead.';
const REMOTE_MASK_ERROR: ImageOperationError = {
  message: 'There was an issue with your request. Please check your inputs and try again',
  errorType: 'invalid_request_error',
  param: null,
  code: null,
};

const invalidRemoteUrlError = (param: string): ImageOperationError => ({
  message: `Invalid '${param}'. Expected a valid URL, but got a value with an invalid format.`,
  errorType: 'invalid_request_error',
  param,
  code: 'invalid_value',
});

const remoteInputError = (source: RemoteImageSource, failure: RemoteImageFailure): ImageOperationError => {
  if (failure.type === 'invalid-url') return invalidRemoteUrlError(source.invalidUrlParam);
  if (failure.type === 'invalid-image' || failure.type === 'empty-body') {
    return {
      message: INVALID_REMOTE_IMAGE_MESSAGE,
      errorType: 'invalid_request_error',
      param: 'input',
      code: 'invalid_value',
    };
  }
  if (failure.type === 'timeout') {
    return {
      message: REMOTE_IMAGE_TIMEOUT_MESSAGE,
      errorType: 'invalid_request_error',
      param: 'url',
      code: 'invalid_value',
    };
  }
  const status = failure.type === 'http-error' || failure.type === 'invalid-redirect'
    ? failure.status
    : undefined;
  return {
    message: status === undefined
      ? 'Error while downloading file.'
      : `Error while downloading file. Upstream status code: ${status}.`,
    errorType: 'invalid_request_error',
    param: 'url',
    code: 'invalid_value',
  };
};

// The shared fetcher enforces the per-body limit while streaming. Native
// OpenAI Responses additionally accepts at most 50 MB across all distinct successful
// image downloads, so account each memoized result once across sources and the
// mask.
// https://platform.openai.com/docs/guides/images-vision#image-input-requirements
const MAX_REMOTE_IMAGE_TOTAL_BYTES = 50 * 1024 * 1024;

const supportedImageMimeFromBytes = (bytes: Uint8Array): string | null => {
  if (dimensionsFromBytes(bytes) === null) return null;
  if (
    bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a
  ) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6) {
    const signature = String.fromCharCode(...bytes.subarray(0, 6));
    if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
  }
  if (
    bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP'
  ) return 'image/webp';
  return null;
};

const createRemoteImageMaterializer = (requestSignal: AbortSignal | undefined) => {
  const fetchImage = createExternalImageFetcher(requestSignal);
  const materialized = new Map<string, ImageSource>();
  const materializedByData = new Map<Uint8Array, ImageSource>();
  let materializedBytes = 0;

  const materialize = async (source: RemoteImageSource): Promise<
    { ok: true; source: ImageSource } | { ok: false; failure: RemoteImageFailure }
  > => {
    const fetched = await fetchImage(source.wireUrl);
    if (fetched.type !== 'success') return { ok: false, failure: fetched };

    const cached = materializedByData.get(fetched.data);
    if (cached !== undefined) return { ok: true, source: cached };

    const mimeType = supportedImageMimeFromBytes(fetched.data);
    if (mimeType === null) return { ok: false, failure: { type: 'invalid-image' } };
    if (materializedBytes + fetched.data.byteLength > MAX_REMOTE_IMAGE_TOTAL_BYTES) {
      return { ok: false, failure: { type: 'aggregate-too-large' } };
    }

    materializedBytes += fetched.data.byteLength;
    const bytes = fetched.data.byteOffset === 0
      && fetched.data.buffer instanceof ArrayBuffer
      && fetched.data.byteLength === fetched.data.buffer.byteLength
      ? fetched.data.buffer
      : Uint8Array.from(fetched.data).buffer;
    const result = { bytes, mimeType };
    materializedByData.set(fetched.data, result);
    return { ok: true, source: result };
  };

  return {
    async inputs(sources: readonly RemoteImageSource[]): Promise<{ ok: true } | { ok: false; error: ImageOperationError }> {
      for (const source of sources) {
        const result = await materialize(source);
        if (!result.ok) return { ok: false, error: remoteInputError(source, result.failure) };
        materialized.set(source.wireUrl, result.source);
      }
      return { ok: true };
    },
    async mask(source: RemoteImageSource): Promise<{ ok: true; source: ImageSource } | { ok: false; error: ImageOperationError }> {
      const result = await materialize(source);
      if (!result.ok) {
        return {
          ok: false,
          error: result.failure.type === 'invalid-url'
            ? invalidRemoteUrlError(source.invalidUrlParam)
            : REMOTE_MASK_ERROR,
        };
      }
      materialized.set(source.wireUrl, result.source);
      return { ok: true, source: result.source };
    },
    cached(source: RemoteImageSource): ImageSource {
      const result = materialized.get(source.wireUrl);
      if (result === undefined) {
        throw new Error('image_generation live source invariant violated after request validation: remote image URL was not materialized');
      }
      return result;
    },
  };
};

type ImageSourceIssue =
  | { kind: 'native'; error: ImageOperationError }
  | { kind: 'gateway'; error: ImageOperationError }
  | { kind: 'invariant'; message: string };

const inputImageDecodeError = (
  path: string,
  failure: Exclude<InputImageDecodeResult, { ok: true }>,
): ImageOperationError => {
  if (failure.reason === 'invalid_format') return invalidRemoteUrlError(path);
  const expected = `Invalid '${path}'. Expected a base64-encoded data URL with an image MIME type (e.g. 'data:image/png;base64,aW1nIGJ5dGVzIGhlcmU=')`;
  const detail = failure.reason === 'missing_base64_separator'
    ? "a value without the ';base64' separator."
    : failure.reason === 'unsupported_mime'
      ? `unsupported MIME type '${failure.mimeType ?? ''}'.`
      : 'an invalid base64-encoded value.';
  return {
    message: `${expected}, but got ${detail}`,
    errorType: 'invalid_request_error',
    param: path,
    code: 'invalid_value',
  };
};

interface ImageSourceInspection {
  sources: ImageSourceReference[];
  issue?: ImageSourceIssue;
}

const inspectImageSourcesWithCache = (
  input: readonly OpenAIResponsesInputItem[],
  decodedSources: Map<string, ImageSource | null>,
): ImageSourceInspection => {
  const sources: ImageSourceReference[] = [];
  let issue: ImageSourceIssue | undefined;
  for (const [inputIndex, item] of input.entries()) {
    for (const { image, path } of inputImagesOf(item, inputIndex)) {
      const imageUrl = typeof image.image_url === 'string' && image.image_url.length > 0 ? image.image_url : null;
      const fileId = typeof image.file_id === 'string' && image.file_id.length > 0 ? image.file_id : null;
      if (imageUrl !== null && fileId !== null) {
        return {
          sources,
          issue: {
            kind: 'native',
            error: {
              message: `Mutually exclusive parameters: '${path}'. Ensure you are only providing one of: 'file_id' or 'image_url'.`,
              errorType: 'invalid_request_error',
              param: path,
              code: 'mutually_exclusive_parameters',
            },
          },
        };
      }
      if (imageUrl !== null) {
        if (/^https?:\/\//i.test(imageUrl)) {
          sources.push({ wireUrl: imageUrl, invalidUrlParam: `${path}.image_url` });
          continue;
        }
        const decoded = decodeInputImageDataUrl(imageUrl, decodedSources);
        if (!decoded.ok) {
          return {
            sources,
            issue: { kind: 'native', error: inputImageDecodeError(`${path}.image_url`, decoded) },
          };
        }
        sources.push(decoded.source);
        continue;
      }
      if (fileId !== null) {
        issue ??= {
          kind: 'gateway',
          error: {
            message: "Floway cannot use file IDs as edit sources; provide an inline image data URL or set image_generation.action to 'generate'.",
            errorType: 'invalid_request_error',
            param: `${path}.file_id`,
            code: 'unsupported_image_source',
          },
        };
      } else {
        return {
          sources,
          issue: {
            kind: 'native',
            error: {
              message: `Missing mutually exclusive parameters: '${path}'. Ensure you are providing exactly one of: 'file_id' or 'image_url'.`,
              errorType: 'invalid_request_error',
              param: path,
              code: 'missing_mutually_exclusive_parameters',
            },
          },
        };
      }
    }
    if (item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.length > 0) {
      // A prior generated image carries no MIME prefix on its bare-base64
      // `result`; pick the fallback from the echoed `output_format` so a
      // JPEG output is not mislabeled PNG on the edit form.
      const fallbackMime = item.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const decoded = decodeInlineImage(item.result, fallbackMime, decodedSources);
      if (decoded === null) {
        return {
          sources,
          issue: {
            kind: 'invariant',
            message: `Stored image_generation_call at input[${inputIndex}] contains invalid result bytes.`,
          },
        };
      } else {
        sources.push(decoded);
      }
    }
  }
  return { sources, ...(issue === undefined ? {} : { issue }) };
};

export const createImageSourceInspector = (): ((input: readonly OpenAIResponsesInputItem[]) => ImageSourceInspection) => {
  const decodedSources = new Map<string, ImageSource | null>();
  return input => inspectImageSourcesWithCache(input, decodedSources);
};

export const inspectImageSources = (input: readonly OpenAIResponsesInputItem[]): ImageSourceInspection =>
  createImageSourceInspector()(input);

type ImageOperation =
  | { ok: true; action: 'generate' | 'edit'; sources: readonly ImageSourceReference[] }
  | { ok: false; error: ImageOperationError };

export const resolveImageOperation = (
  config: ImageGenerationConfig,
  inspection: ImageSourceInspection,
): ImageOperation => {
  const { sources, issue } = inspection;
  if (issue?.kind === 'native') return { ok: false, error: issue.error };
  if (issue?.kind === 'invariant') throw new Error(issue.message);
  if (issue?.kind === 'gateway' && config.action !== 'generate') return { ok: false, error: issue.error };

  const hasEditContext = sources.length > 0 || config.mask !== undefined;
  const action = config.action === 'edit' || (config.action === 'auto' && hasEditContext)
    ? 'edit'
    : 'generate';

  if (config.action === 'edit' && !hasEditContext) {
    return {
      ok: false,
      error: {
        message: "ImageGenTool action 'edit' requires an image, mask, or previous context",
        errorType: 'image_generation_user_error',
        param: 'input',
        code: null,
      },
    };
  }

  const editSources = action === 'edit' && sources.length === 0 && config.mask !== undefined
    ? [config.mask]
    : sources;
  return { ok: true, action, sources: action === 'edit' ? editSources : [] };
};

// The successfully-resolved image, or a normalized failure. Failures are
// replayed to the orchestrator as the tool's output (never synthesized into
// a downstream response.failed) so the model can retry, re-parameterize, or
// continue. The full upstream error shape (type/code/message) is preserved so
// the orchestrator can distinguish transient overload from a terminal
// content-policy block.
interface HostedToolState {
  config: MaterializedImageGenerationConfig;
  gateway: GatewayCtx;
  imageDispatchCount: number;
}

// Output-as-input round-trip: the multi-turn loop feeds accumulated
// `image_generation_call` items back as the next turn's input, and client
// histories may echo prior ones. Non-OpenAI-Responses upstreams can't read the item
// type, so rewrite each into a `function_call` + `function_call_output` pair
// so the orchestrator sees that it called the tool and what it returned. For
// a successful call we additionally surface the generated bytes as an
// `input_image` message, matching Azure's native flow where the image stays
// in the orchestrator's multimodal context — so the model can describe or
// iteratively edit what it just produced. The same bytes also reached the
// downstream client on the synthesized `image_generation_call` item.
//
// Fidelity across requests: a client may echo a prior call back as a bare id
// with the bytes dropped. By the time this seam runs the input item already
// carries the full result payload — inspectImageSources can bind result bytes
// directly without any out-of-band lookup. The `image_generation_call` shape
// needs no out-of-band payload for this to be lossless: every field required
// to rebuild the pair, INCLUDING the error (`status` + `error{message,code,
// type}`), has a public home on the item.
export const transformInputItemsForImageGeneration = (
  input: OpenAIResponsesInputItem[],
  toolName: string,
): OpenAIResponsesInputItem[] => {
  const out: OpenAIResponsesInputItem[] = [];
  for (const item of input) {
    if (item.type !== 'image_generation_call') {
      out.push(item);
      continue;
    }
    const ig = item as OpenAIResponsesInputImageGenerationCall;
    const id = ig.id !== undefined && ig.id.length > 0 ? ig.id : synthesizeImageGenerationCallId();
    const callId = `cc_from_${id}`;
    // Replay the full failure detail (code/message/retryable) the orchestrator
    // needs to decide between retry, re-parameterize, and apology — a bare
    // status would hide whether the failure was transient (EngineOverloaded)
    // or terminal (content_filter).
    const output = ig.status === 'failed'
      ? JSON.stringify({
          ok: false,
          error: {
            type: ig.error?.type ?? 'image_generation_error',
            code: ig.error?.code ?? 'server_error',
            message: ig.error?.message ?? 'Image generation failed.',
            retryable: isRetryableImageError(ig.error?.code ?? '', ig.error?.type),
          },
        })
      : JSON.stringify({ ok: true, status: 'completed', id });
    const functionCall: OpenAIResponsesFunctionToolCallItem = {
      type: 'function_call',
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify({ prompt: ig.revised_prompt ?? '' }),
      status: 'completed',
    };
    const functionCallOutput: OpenAIResponsesFunctionCallOutputItem = {
      type: 'function_call_output',
      call_id: callId,
      output,
    };
    out.push(functionCall, functionCallOutput);

    if (ig.status !== 'failed' && typeof ig.result === 'string' && ig.result.length > 0) {
      const mime = ig.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
      out.push({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'Generated image:' },
          { type: 'input_image', image_url: `data:${mime};base64,${ig.result}`, detail: 'auto' },
        ],
      });
    }
  }
  return out;
};

export const imageGenerationHostedTool: HostedToolRegistration = async (invocation, gatewayCtx) => {
  if (invocation.targetApi === 'openaiResponses' && !providerModelOf(invocation.candidate).enabledFlags.has('openai-responses-image-generation-shim')) {
    return { type: 'inactive' };
  }

  const declarations = collectOpenAIResponsesToolEntries(invocation.payload);
  const tools = declarations.map(entry => entry.tool);
  const hasHostedTool = tools.some(isHostedImageGenerationTool);
  const hasReplayInput = invocation.payload.input.some(i => i.type === 'image_generation_call');
  if (!hasHostedTool && !hasReplayInput) return { type: 'inactive' };

  if (!hasHostedTool) {
    // Replay-only activation: rewrite echoed image_generation_call items so
    // the upstream can read them, but there is no hosted tool to dispatch.
    return {
      type: 'active',
      baseToolName: FUNCTION_TOOL_NAME,
      transformItems: transformInputItemsForImageGeneration,
    };
  }

  const prepared = prepareImageGenerationConfig(tools, declarations.map(entry => entry.path));
  if (!prepared.ok) {
    return { type: 'invalid-request', message: prepared.error.message, param: prepared.error.param, code: prepared.error.code };
  }
  const config = prepared.config;
  const inspectSources = createImageSourceInspector();
  const initialInspection = inspectSources(invocation.payload.input);
  const initialOperation = resolveImageOperation(config, initialInspection);
  if (!initialOperation.ok) {
    return {
      type: 'invalid-request',
      message: initialOperation.error.message,
      param: initialOperation.error.param,
      errorType: initialOperation.error.errorType,
      code: initialOperation.error.code,
    };
  }

  const materializer = createRemoteImageMaterializer(gatewayCtx.abortSignal);
  const remoteInputs = initialInspection.sources.filter(isRemoteImageSource);
  const materializedInputs = await materializer.inputs(remoteInputs);
  if (!materializedInputs.ok) {
    return {
      type: 'invalid-request',
      message: materializedInputs.error.message,
      param: materializedInputs.error.param,
      errorType: materializedInputs.error.errorType,
      code: materializedInputs.error.code,
    };
  }
  let mask: ImageSource | undefined;
  if (config.mask !== undefined) {
    if (isRemoteImageSource(config.mask)) {
      const remoteMask = config.mask;
      const materializedMask = await materializer.mask(remoteMask);
      if (!materializedMask.ok) {
        return {
          type: 'invalid-request',
          message: materializedMask.error.message,
          param: materializedMask.error.param,
          errorType: materializedMask.error.errorType,
          code: materializedMask.error.code,
        };
      }
      if (remoteMask.afterMaterializationError !== undefined) {
        return {
          type: 'invalid-request',
          message: remoteMask.afterMaterializationError.message,
          param: remoteMask.afterMaterializationError.param,
          code: remoteMask.afterMaterializationError.code,
        };
      }
      mask = materializedMask.source;
    } else {
      mask = config.mask;
    }
  }
  const { mask: _unmaterializedMask, ...configWithoutMask } = config;
  const materializedConfig: MaterializedImageGenerationConfig = {
    ...configWithoutMask,
    ...(mask === undefined ? {} : { mask }),
  };

  const state: HostedToolState = {
    config: materializedConfig,
    gateway: gatewayCtx,
    imageDispatchCount: 0,
  };

  return {
    type: 'active',
    baseToolName: FUNCTION_TOOL_NAME,
    transformItems: transformInputItemsForImageGeneration,
    hosted: {
      hostedTypes: ['image_generation'],
      canonicalize: canonicalizeImageGenerationTool,
      buildFunctionTool: buildImageGenerationFunctionTool,
      dispatcher: ({ intercepted }) => {
        const promptArg = intercepted.arguments !== null && typeof intercepted.arguments.prompt === 'string'
          ? intercepted.arguments.prompt
          : '';
        const id = synthesizeImageGenerationCallId();
        // Later ReAct turns include prior hosted-tool output in the live input.
        // Resolve and validate again so action:auto can pivot from generation
        // to editing without bypassing the same source policy used at ingress.
        // The per-request inspector cache reuses bytes already decoded during
        // registration and earlier turns.
        const operation = resolveImageOperation(materializedConfig, inspectSources(invocation.payload.input));
        if (!operation.ok) {
          throw new Error(`image_generation live source invariant violated after request validation: ${operation.error.message}`);
        }
        const sources = operation.sources.map(source => {
          return isRemoteImageSource(source) ? materializer.cached(source) : source;
        });

        // Safety valve against an unbounded backend-call loop (the model
        // retrying after repeated {ok:false} outcomes): once this response has
        // issued IMAGE_ITERATION_CAP real backend image calls, stop hitting the
        // backend and replay an exhausted tool output so the model steers toward
        // a terminal answer. The exhausted item is a failure, so its `action`
        // field is unused.
        if (state.imageDispatchCount >= IMAGE_ITERATION_CAP) {
          return [{
            id,
            startItem: { type: 'image_generation_call', status: 'in_progress' },
            startEvents: [{ type: 'response.image_generation_call.in_progress' }, { type: 'response.image_generation_call.generating' }],
            async *run() {
              return imageTerminal(promptArg, 'generate', {
                ok: false,
                error: { type: 'image_generation_error', code: 'tool_call_budget_exhausted', message: `Image generation budget (${IMAGE_ITERATION_CAP} attempts) reached for this response. Summarize and finish without another image.`, retryable: false },
              });
            },
          }];
        }
        state.imageDispatchCount += 1;

        return [{
          id,
          startItem: { type: 'image_generation_call', status: 'in_progress' },
          startEvents: [
            { type: 'response.image_generation_call.in_progress' },
            { type: 'response.image_generation_call.generating' },
          ],
          // Its own run: its own prologue, its own settlement, its own record. What this
          // yields is that run's lifecycle, spliced into the turn that asked for it.
          run: () => (async function* (): AsyncGenerator<HostedToolLifecycleEvent, HostedToolTerminal> {
            let call;
            try {
              call = await runImageGenerationSubRequest(
                state.gateway,
                portableImageRequest(promptArg, operation.action, state.config, sources),
              );
            } catch (error) {
              return imageTerminal(promptArg, operation.action, { ok: false, error: serverError(error) });
            }
            try {
              return yield* call.lifecycle;
            } finally {
              await call.drain();
            }
          })(),
        }];
      },
    },
  };
};
