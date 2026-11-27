import { isEqual } from 'es-toolkit';

import { sleep } from '../../../../../shared/sleep.ts';
import { openaiImagesEditsOperation, openaiImagesGenerationsOperation } from '../../../../non-chat/openai-images/index.ts';
import { createExternalImageFetcher, type ExternalImageFetchResult } from '../../../shared/external-image-fetcher.ts';
import { hostedToolRequest, type HostedToolContext, type ServerToolHistoryExpansion, type ServerToolLifecycleEvent, type ServerToolOutputItem, type ServerToolRegistration, type ServerToolSlotResult } from '../hosted-tools.ts';
import { getHeader } from '@floway-dev/http';
import { dimensionsFromBytes, getImageProcessor } from '@floway-dev/platform';
import { decodeForgivingBase64, encodeHex, isImageMediaType, isJsonObject, mediaTypeEssence } from '@floway-dev/protocols/common';
import type { OpenAIImagesEditsPayload, OpenAIImagesGenerationsPayload, OpenAIImagesStreamItem } from '@floway-dev/protocols/openai-images';
import {
  collectOpenAIResponsesToolEntries,
  createRandomOpenAIResponsesItemId,
  type OpenAIResponsesFunctionTool,
  type OpenAIResponsesImageGenerationTool,
  type OpenAIResponsesInputImage,
  type OpenAIResponsesInputImageGenerationCall,
  type CanonicalOpenAIResponsesInputItem,
  type OpenAIResponsesOutputImageGenerationCall,
  type OpenAIResponsesTool,
} from '@floway-dev/protocols/openai-responses';

export const SHIM_TOOL_NAME = 'image_generation';

// Default image backend when the hosted tool omits `model`. gpt-image-2 is
// the reference backend Azure's native OpenAI Responses `image_generation` routes
// to; operators provision it under this public id (or alias it).
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

// Safety valve on the multi-turn ReAct loop: cap how many real image backend
// calls one response may dispatch (counted on `ShimState.imageDispatchCount`,
// not the shared ReAct turn count, so unrelated turns do not consume the
// budget). Past the cap the dispatcher replays an exhausted-budget tool output
// instead of hitting the backend, so a model that keeps retrying after failures
// cannot drive unbounded image cost.
const IMAGE_ITERATION_CAP = 10;

// Public OpenAI Responses `image_generation` tool config enums (Azure-strict
// surface). `webp` and arbitrary `WxH` sizes are rejected because the
// native Azure path rejects them; the shim mirrors that vocabulary rather
// than passing them to a backend that would 400 with a different shape.
const ALLOWED_SIZES = new Set(['1024x1024', '1024x1536', '1536x1024', 'auto']);
const ALLOWED_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const ALLOWED_BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);
const ALLOWED_OUTPUT_FORMATS = new Set(['png', 'jpeg']);
const ALLOWED_MODERATIONS = new Set(['auto', 'low']);
const ALLOWED_ACTIONS = new Set(['generate', 'edit', 'auto']);
const ALLOWED_INPUT_FIDELITY = new Set(['high', 'low']);

// gpt-image-* `/images/edits` accepts only these input image mimetypes; a live
// Azure probe confirmed png/jpeg/webp succeed while gif is rejected with
// `unsupported_file_mimetype`. Native OpenAI Responses accepts the same GIF and
// re-encodes it before editing, so the shim mirrors that behavior through the
// platform image processor. Common aliases are folded onto the backend form.
type EditMime = 'image/png' | 'image/jpeg' | 'image/webp';

const EDIT_MIME_ALIASES: Record<string, EditMime> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};
// The canonical edit-supported mimetype for a source, or null when the
// standalone endpoint requires local WebP transcoding first.
const editSupportedMime = (mime: string): EditMime | null => {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime;
  return canonical === 'image/png' || canonical === 'image/jpeg' || canonical === 'image/webp'
    ? canonical
    : null;
};

const editFileExt = (mime: EditMime): string =>
  mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';

// The public `image_generation` tool-config surface. Azure rejects any other
// field with `unknown_parameter`, so the shim mirrors that strictness rather
// than silently forwarding unknown fields (which would diverge from the
// emulated surface and hide client bugs). `n` is deliberately absent: Azure
// echoes `n:1` internally but rejects a client-supplied `tools[].n`.
const KNOWN_TOOL_FIELDS = new Set([
  'type', 'model', 'size', 'quality', 'background', 'output_format',
  'output_compression', 'moderation', 'partial_images', 'input_fidelity',
  'input_image_mask', 'action',
]);

export const isHostedImageGenerationTool = (tool: OpenAIResponsesTool): tool is OpenAIResponsesImageGenerationTool =>
  tool.type === 'image_generation';

// Identity canonicalization for image_generation: the shim doesn't
// depend on filled defaults to run, and the OpenAI spec defaults for
// `background` / `quality` / `size` / etc. observed via Azure echo
// (all `'auto'`) signal "backend decides" rather than concrete values
// the model needs. Preserving the client's raw shape keeps the echo
// round-trip minimal — anything the client didn't send stays absent.
export const recognizeImageGenerationTool = (raw: OpenAIResponsesTool): OpenAIResponsesImageGenerationTool | undefined =>
  isHostedImageGenerationTool(raw) ? raw : undefined;

// A base64-data-URL or bare-base64 image source bound for an edit call.
// Bytes are held in a concrete ArrayBuffer so they can be wrapped in a Blob.
interface ImageSource {
  bytes: ArrayBuffer;
  mimeType: string;
}

interface PreparedImageSource extends ImageSource {
  mimeType: EditMime;
}

interface RemoteImageSource {
  wireUrl: string;
  invalidUrlParam: string;
  afterMaterializationError?: PrepareConfigError;
}

type ImageSourceReference = ImageSource | RemoteImageSource;

const isRemoteImageSource = (source: ImageSourceReference): source is RemoteImageSource =>
  'wireUrl' in source;

const prepareEditSources = async (sources: readonly ImageSource[]): Promise<readonly PreparedImageSource[]> => {
  const preparedByContent = new Map<string, Promise<PreparedImageSource>>();
  return await Promise.all(sources.map(async source => {
    const mimeType = editSupportedMime(source.mimeType);
    if (mimeType !== null) return { bytes: source.bytes, mimeType };
    const digest = await crypto.subtle.digest('SHA-256', source.bytes);
    const key = `${source.mimeType}\u0000${encodeHex(new Uint8Array(digest))}`;

    let prepared = preparedByContent.get(key);
    if (prepared === undefined) {
      // Native OpenAI Responses accepts formats such as GIF through its multimodal
      // preprocessing, while the standalone edits endpoint accepts only
      // PNG/JPEG/WebP. Re-encode locally to preserve the hosted-tool behavior.
      // https://github.com/openai/openai-node/blob/ec2f57fd0d66e94782656b986d7b3eb03225369c/src/resources/images.ts#L560-L572
      prepared = getImageProcessor().compressToWebp(new Uint8Array(source.bytes), null).then(encoded => {
        const bytes = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer;
        return { bytes, mimeType: 'image/webp' } satisfies PreparedImageSource;
      });
      preparedByContent.set(key, prepared);
    }
    return await prepared;
  }));
};

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
  // after the server-tool replay transform. Keying by decoded wire identity
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

// The orchestrator-visible tool config the shim layers onto the backend
// call. Mirrors Azure: the orchestrator only chooses `prompt`; everything
// here is read from the client's hosted-tool entry and applied by the shim.
export interface ImageGenerationConfig {
  model: string;
  size?: string;
  quality?: string;
  output_format?: 'png' | 'jpeg';
  background?: 'transparent' | 'opaque' | 'auto';
  moderation?: 'auto' | 'low';
  output_compression?: number;
  // When > 0, the backend call is issued with `stream:true` and each
  // progressively-rendered preview the backend emits is relayed as a native
  // `image_generation_call.partial_image` frame. When 0/absent the backend
  // is called non-streaming and no preview frames are produced.
  partial_images?: number;
  input_fidelity?: 'high' | 'low';
  // Inpainting mask materialized once at validation, forwarded to
  // /images/edits as the standalone `mask` part. `file_id` masks are not
  // supported (rejected at validation) — resolving them needs the Files API.
  mask?: ImageSourceReference;
  action: 'generate' | 'edit' | 'auto';
}

type MaterializedImageGenerationConfig = Omit<ImageGenerationConfig, 'mask'> & { mask?: ImageSource };

const prepareEditRequest = async (
  sources: readonly ImageSource[],
  config: MaterializedImageGenerationConfig,
): Promise<{ sources: readonly PreparedImageSource[]; mask?: PreparedImageSource }> => {
  if (config.mask === undefined) return { sources: await prepareEditSources(sources) };
  const prepared = await prepareEditSources([...sources, config.mask]);
  const mask = prepared.at(-1);
  if (mask === undefined) throw new Error('Missing prepared image edit mask');
  return { sources: prepared.slice(0, -1), mask };
};

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
// values supported by this shim. The caller validates every
// declaration before selecting the last config, so an earlier invalid entry
// fails. toolPath identifies its source carrier in the error.
// https://developers.openai.com/api/docs/guides/tools-image-generation
const validateHostedImageGenerationEntry = (
  tool: OpenAIResponsesImageGenerationTool,
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
      ...(typeof background === 'string' ? { background: background as NonNullable<ImageGenerationConfig['background']> } : {}),
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
// tool's surface (size/quality/etc. are NOT model-chosen; the shim layers them
// on from the client config, exactly like Azure). A minimal description
// elicits native-quality refined prompts while costing ~50 input tokens vs
// the native hosted tool's ~2300.
export const buildImageGenerationFunctionTool = (_canonical: OpenAIResponsesImageGenerationTool, name: string): OpenAIResponsesFunctionTool => ({
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

const inputImagesOf = (item: CanonicalOpenAIResponsesInputItem, inputIndex: number): InputImageEntry[] => {
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
  input: readonly CanonicalOpenAIResponsesInputItem[],
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

export const createImageSourceInspector = (): ((input: readonly CanonicalOpenAIResponsesInputItem[]) => ImageSourceInspection) => {
  const decodedSources = new Map<string, ImageSource | null>();
  return input => inspectImageSourcesWithCache(input, decodedSources);
};

export const inspectImageSources = (input: readonly CanonicalOpenAIResponsesInputItem[]): ImageSourceInspection =>
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
type ImageError = { type: string; code: string; message: string; retryable: boolean };

// Server-resolved tool config echoed by the backend on both the partial_image
// frames and the final result (`background:"auto"` becomes the concrete value
// the server picked, etc.). Read straight off the backend rather than inferred
// from the request, so what we surface matches what was actually rendered.
interface EchoFields {
  output_format?: 'png' | 'jpeg';
  quality?: 'low' | 'medium' | 'high';
  background?: 'transparent' | 'opaque';
  size?: string;
}

export type ImageOutcome =
  | { ok: true; b64: string; echo: EchoFields }
  | { ok: false; error: ImageError };

// Project the server-resolved echo fields out of a backend payload (a response
// JSON body or an SSE event). Each field is validated against the public enum
// so a surprising backend value is dropped rather than echoed verbatim.
const extractEcho = (source: unknown): EchoFields => {
  if (source === null || typeof source !== 'object') return {};
  const s = source as Record<string, unknown>;
  const echo: EchoFields = {};
  if (s.output_format === 'png' || s.output_format === 'jpeg') echo.output_format = s.output_format;
  if (s.quality === 'low' || s.quality === 'medium' || s.quality === 'high') echo.quality = s.quality;
  if (s.background === 'transparent' || s.background === 'opaque') echo.background = s.background;
  if (typeof s.size === 'string') echo.size = s.size;
  return echo;
};

const RETRYABLE_IMAGE_ERROR_CODES = new Set([
  'EngineOverloaded', 'server_error', 'image_generation_server_error', 'image_generation_failed',
]);

const isRetryableImageError = (code: string, type?: string): boolean =>
  RETRYABLE_IMAGE_ERROR_CODES.has(code) || (type !== undefined && RETRYABLE_IMAGE_ERROR_CODES.has(type));

const errorFromBody = (body: unknown, status: number, source: 'local' | 'upstream'): ImageError => {
  const error = isJsonObject(body) && isJsonObject(body.error) ? body.error : undefined;
  const message = typeof error?.message === 'string' ? error.message : `Image backend returned HTTP ${status}`;
  if (source === 'local' && (status === 404 || status === 400)) {
    return { type: 'image_generation_error', message, code: status === 404 ? 'model_not_found' : 'model_not_supported', retryable: false };
  }
  const code = typeof error?.code === 'string' ? error.code : `upstream_${status}`;
  const type = typeof error?.type === 'string' ? error.type : 'image_generation_error';
  return { type, code, message, retryable: isRetryableImageError(code, type) };
};

const buildGenerationsBody = (prompt: string, config: ImageGenerationConfig, stream: boolean): OpenAIImagesGenerationsPayload => ({
  model: config.model,
  prompt,
  // Public OpenAI Responses tool config forbids `n`, but the private standalone
  // backend call always requests a single image, mirroring Azure's
  // single-image OpenAI Responses behavior.
  n: 1,
  // `response_format` is intentionally not sent: gpt-image-* always returns
  // base64 (`data[0].b64_json`) and rejects `response_format`, so the inline
  // extraction below reads `b64_json` directly.
  ...(config.size !== undefined ? { size: config.size } : {}),
  ...(config.quality !== undefined ? { quality: config.quality } : {}),
  ...(config.output_format !== undefined ? { output_format: config.output_format } : {}),
  ...(config.background !== undefined ? { background: config.background } : {}),
  ...(config.moderation !== undefined ? { moderation: config.moderation } : {}),
  ...(config.output_compression !== undefined ? { output_compression: config.output_compression } : {}),
  ...(stream ? { stream: true, partial_images: config.partial_images } : {}),
});

const buildEditsRequest = (
  prompt: string,
  config: ImageGenerationConfig,
  sources: readonly PreparedImageSource[],
  mask: PreparedImageSource | undefined,
  stream: boolean,
): OpenAIImagesEditsPayload => {
  const parameters: Record<string, string | number | boolean> = {
    prompt,
    n: 1,
    ...(config.size === undefined ? {} : { size: config.size }),
    ...(config.quality === undefined ? {} : { quality: config.quality }),
    ...(config.output_format === undefined ? {} : { output_format: config.output_format }),
    ...(config.background === undefined ? {} : { background: config.background }),
    ...(config.moderation === undefined ? {} : { moderation: config.moderation }),
    ...(config.output_compression === undefined ? {} : { output_compression: config.output_compression }),
    ...(config.input_fidelity === undefined ? {} : { input_fidelity: config.input_fidelity }),
    ...(stream ? { stream: true, partial_images: config.partial_images } : {}),
  };
  const images = sources.map((source, index) => ({
    type: 'upload' as const,
    file: { bytes: new Uint8Array(source.bytes), name: `image_${index}.${editFileExt(source.mimeType)}`, mediaType: source.mimeType },
  }));
  const maskFile = mask === undefined
    ? undefined
    : { bytes: new Uint8Array(mask.bytes), name: `mask.${editFileExt(mask.mimeType)}`, mediaType: mask.mimeType };
  return {
    images,
    ...(maskFile === undefined ? {} : { mask: { type: 'upload' as const, file: maskFile } }),
    parameters,
  };
};

const serverError = (e: unknown): ImageError => ({
  type: 'image_generation_error',
  message: e instanceof Error ? e.message : String(e),
  code: 'server_error',
  retryable: true,
});

// 60s cap matches the per-minute refill window of Azure TPM/RPM and
// openai.com tier image quotas — same clamp openai-python applies in
// [`_calculate_retry_timeout`](https://github.com/openai/openai-python/blob/d76d8c11c1da9f97aa8a0aaee8ccd44d2bc8f5e7/src/openai/_base_client.py#L789).
const RETRY_CAP_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;
const MAX_COMPLETED_IMAGE_BYTES = 64 * 1024 * 1024;

// Header priority matches openai-python's `_parse_retry_after_header` with
// Azure's `x-ms-retry-after-ms` alias added. Treats <= 0 as "no hint" so the
// gpt-image-1 `retry-after: 0.0` quirk falls back to backoff instead of
// pretending the quota is free.
export const parseRetryAfterMs = (headers: Headers): number | null => {
  for (const name of ['retry-after-ms', 'x-ms-retry-after-ms']) {
    const raw = headers.get(name);
    if (raw === null) continue;
    const ms = Number(raw);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  const ra = headers.get('retry-after');
  if (ra !== null) {
    const seconds = Number(ra);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
    const httpDateMs = Date.parse(ra);
    if (!Number.isNaN(httpDateMs)) {
      const delta = httpDateMs - Date.now();
      if (delta > 0) return delta;
    }
  }
  return null;
};

const imageReplayInputs = (item: Pick<OpenAIResponsesInputImageGenerationCall, 'action' | 'revised_prompt' | 'size' | 'quality' | 'output_format' | 'background'>) => ({
  action: item.action,
  revised_prompt: item.revised_prompt,
  size: item.size,
  quality: item.quality,
  output_format: item.output_format,
  background: item.background,
});

// Build the completed/failed `image_generation_call` output item plus its
// closing events. On success the final bytes ride `output_item.done.item.result`
// and a `response.image_generation_call.completed` closes the item; on failure
// neither `.completed` nor any `.partial_image` is emitted — only the failed
// `output_item.done`.
//
// `revised_prompt` is set to the orchestrator's prompt: the standalone images
// backend does no prompt rewriting and returns no `revised_prompt`, and the
// orchestrator's emitted prompt IS already its refined rewrite (it plays the
// role Azure's native flow gives the orchestrator), so it is the faithful
// source for this field.
export const imageTerminal = (
  prompt: string,
  action: 'generate' | 'edit',
  outcome: ImageOutcome,
): ServerToolSlotResult => {
  if (!outcome.ok) {
    const item: ServerToolOutputItem & Omit<OpenAIResponsesOutputImageGenerationCall, 'id'> = {
      type: 'image_generation_call',
      status: 'failed',
      result: null,
      revised_prompt: prompt,
      error: { message: outcome.error.message, code: outcome.error.code, type: outcome.error.type, param: null },
    };
    return { item, endEvents: [], replayData: imageReplayInputs(item) };
  }

  const item: ServerToolOutputItem & Omit<OpenAIResponsesOutputImageGenerationCall, 'id'> = {
    type: 'image_generation_call',
    status: 'completed',
    action,
    result: outcome.b64,
    revised_prompt: prompt,
    ...outcome.echo,
  };
  return { item, endEvents: [{ type: 'response.image_generation_call.completed' }], replayData: imageReplayInputs(item) };
};

// One standalone-images SSE data line, folded into a backend-agnostic signal.
// The generations and edits endpoints use distinct event prefixes
// (`image_generation.*` vs `image_edit.*`); only the suffix is matched here.
type ImageStreamSignal =
  | { kind: 'partial'; index: number; b64: string; echo: EchoFields }
  | { kind: 'completed'; b64: string | undefined; echo: EchoFields }
  | { kind: 'error'; error: ImageError }
  | null;

export const parseImageStreamEvent = ({ data: evt, eventName }: OpenAIImagesStreamItem): ImageStreamSignal => {
  const type = evt.type ?? eventName;
  if (type === undefined) return null;
  if (type.endsWith('.partial_image')) {
    return {
      kind: 'partial',
      index: typeof evt.partial_image_index === 'number' ? evt.partial_image_index : 0,
      b64: typeof evt.b64_json === 'string' ? evt.b64_json : '',
      echo: extractEcho(evt),
    };
  }
  if (type.endsWith('.completed')) {
    return { kind: 'completed', b64: typeof evt.b64_json === 'string' ? evt.b64_json : undefined, echo: extractEcho(evt) };
  }
  if (type === 'error') {
    const err = isJsonObject(evt.error) ? evt.error : undefined;
    const code = typeof err?.code === 'string' ? err.code : 'server_error';
    const errType = typeof err?.type === 'string' ? err.type : 'image_generation_error';
    return {
      kind: 'error',
      error: { type: errType, code, message: typeof err?.message === 'string' ? err.message : 'Image backend stream reported an error.', retryable: isRetryableImageError(code, errType) },
    };
  }
  return null;
};

const streamImageGeneration = async function* (
  prompt: string,
  action: 'generate' | 'edit',
  sources: readonly ImageSource[],
  config: MaterializedImageGenerationConfig,
  { facts, scope }: HostedToolContext,
): AsyncGenerator<ServerToolLifecycleEvent, ServerToolSlotResult> {
  const wantsPartials = (config.partial_images ?? 0) > 0;
  let editRequest: OpenAIImagesEditsPayload | undefined;
  if (action === 'edit') {
    const prepared = await prepareEditRequest(sources, config);
    editRequest = buildEditsRequest(prompt, config, prepared.sources, prepared.mask, wantsPartials);
  }

  const finish = (outcome: ImageOutcome) => imageTerminal(prompt, action, outcome);
  for (let retry = 0; ; retry++) {
    const call = editRequest === undefined
      ? scope.run(openaiImagesGenerationsOperation, {
          ...hostedToolRequest(facts, '/v1/images/generations'),
          'openaiImagesGenerations': buildGenerationsBody(prompt, config, wantsPartials),
        })
      : scope.run(openaiImagesEditsOperation, {
          ...hostedToolRequest(facts, '/v1/images/edits'),
          'requestedModel': config.model,
          'openaiImagesEdits': editRequest,
        });
    const answer = await call.catch(error => {
      scope.abort(call);
      throw error;
    });
    let delayMs: number | undefined;
    try {
      const http = answer['http'];
      const outcome = 'openaiImagesGenerations' in answer
        ? answer['openaiImagesGenerations'] : answer['openaiImagesEdits'];
      if (outcome.kind === 'error') {
        const status = http?.status ?? 502;
        if (status === 429 && retry < MAX_RATE_LIMIT_RETRIES && !scope.signal.aborted) {
          const headers = new Headers();
          for (const headerName of ['retry-after-ms', 'x-ms-retry-after-ms', 'retry-after']) {
            const value = http && getHeader(http.headers, headerName);
            if (typeof value === 'string') headers.set(headerName, value);
          }
          const base = 1000 * 2 ** retry;
          delayMs = Math.min(parseRetryAfterMs(headers) ?? base + Math.random() * base * 0.25, RETRY_CAP_MS);
        } else {
          return finish({ ok: false, error: errorFromBody(outcome.error, status, outcome.source) });
        }
      } else if (outcome.kind === 'result') {
        const first = Array.isArray(outcome.result.data) ? outcome.result.data[0] : undefined;
        if (isJsonObject(first) && typeof first.b64_json === 'string') {
          return finish({ ok: true, b64: first.b64_json, echo: extractEcho(outcome.result) });
        }
        return finish({ ok: false, error: { type: 'image_generation_error', message: 'Image backend response did not contain image bytes.', code: 'server_error', retryable: true } });
      } else {
        let finalB64: string | undefined;
        let finalEcho: EchoFields = {};
        for await (const item of scope.read(outcome.stream)) {
          if (!item.ok) {
            return finish({ ok: false, error: serverError(item.error.cause) });
          }
          const signal = parseImageStreamEvent(item.value);
          if (signal === null) continue;
          if (signal.kind === 'partial') {
            yield { type: 'response.image_generation_call.partial_image', partial_image_index: signal.index, partial_image_b64: signal.b64, ...signal.echo };
          } else if (signal.kind === 'completed') {
            if (signal.b64 !== undefined && signal.b64.length > MAX_COMPLETED_IMAGE_BYTES) {
              throw new RangeError(`Hosted image completion exceeds the ${MAX_COMPLETED_IMAGE_BYTES}-byte base64 limit`);
            }
            finalB64 = signal.b64;
            finalEcho = signal.echo;
          } else {
            return finish({ ok: false, error: signal.error });
          }
        }
        return finalB64 === undefined
          ? finish({ ok: false, error: { type: 'image_generation_error', message: 'Image backend stream ended without a completed image.', code: 'server_error', retryable: true } })
          : finish({ ok: true, b64: finalB64, echo: finalEcho });
      }
    } finally {
      scope.abort(call);
      scope.discard(answer);
    }

    try {
      await sleep(delayMs, scope.signal);
    } catch (error) {
      if (error !== scope.signal.reason) throw error;
      return finish({ ok: false, error: serverError(error) });
    }
  }
};

export const expandImageGenerationCall = (
  item: OpenAIResponsesInputImageGenerationCall,
  replay?: { data: unknown },
): ServerToolHistoryExpansion => {
  if (replay !== undefined && !isJsonObject(replay.data)) throw new TypeError('Invalid image generation replay data');
  const id = item.id !== undefined && item.id.length > 0 ? item.id : synthesizeImageGenerationCallId();
  // Replay the full failure detail (code/message/retryable) the orchestrator
  // needs to decide between retry, re-parameterize, and apology — a bare
  // status would hide whether the failure was transient (EngineOverloaded)
  // or terminal (content_filter).
  const output = item.status === 'failed'
    ? JSON.stringify({
        ok: false,
        error: {
          type: item.error?.type ?? 'image_generation_error',
          code: item.error?.code ?? 'server_error',
          message: item.error?.message ?? 'Image generation failed.',
          retryable: isRetryableImageError(item.error?.code ?? '', item.error?.type),
        },
      })
    : JSON.stringify({ ok: true, status: 'completed', id });
  const feedback: ServerToolHistoryExpansion['feedback'] = [];

  // Also provide vision input so subsequent turns can inspect or edit the image.
  if (item.status !== 'failed' && typeof item.result === 'string' && item.result.length > 0) {
    const mime = item.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
    feedback.push({
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'Generated image:' },
        { type: 'input_image', image_url: `data:${mime};base64,${item.result}`, detail: 'auto' },
      ],
    });
  }
  if (replay !== undefined && isEqual(replay.data, imageReplayInputs(item))) {
    return { callSource: 'replay', output, feedback };
  }
  return {
    callSource: 'synthesized',
    synthesizedCall: { callId: `cc_from_${id}`, arguments: JSON.stringify({ prompt: item.revised_prompt ?? '' }) },
    output,
    feedback,
  };
};

export const imageGenerationServerTool: ServerToolRegistration = async (facts, scope) => {
  const request = facts['openaiResponses'];
  const model = facts['model'];
  if (facts['chat.target'] === 'openaiResponses' && !model.enabledFlags.includes('openai-responses-image-generation-shim')) {
    return { type: 'inactive' };
  }

  const declarations = collectOpenAIResponsesToolEntries(request);
  const tools = declarations.map(entry => entry.tool);
  const hasHostedTool = tools.some(isHostedImageGenerationTool);
  const hasReplayInput = request.input.some(i => i.type === 'image_generation_call');
  if (!hasHostedTool && !hasReplayInput) return { type: 'inactive' };
  const expandHistoryItem = (item: CanonicalOpenAIResponsesInputItem, replay?: { data: unknown }) => item.type === 'image_generation_call'
    ? expandImageGenerationCall(item, replay)
    : undefined;

  if (!hasHostedTool) {
    // Replay-only activation: rewrite echoed image_generation_call items so
    // the upstream can read them, but there is no hosted tool to dispatch.
    return {
      type: 'active',
      baseToolName: SHIM_TOOL_NAME,
      expandHistoryItem,
    };
  }

  const prepared = prepareImageGenerationConfig(tools, declarations.map(entry => entry.path));
  if (!prepared.ok) {
    return { type: 'invalid-request', message: prepared.error.message, param: prepared.error.param, code: prepared.error.code };
  }
  const config = prepared.config;
  const inspectSources = createImageSourceInspector();
  const initialInspection = inspectSources(request.input);
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

  const materializer = createRemoteImageMaterializer(scope.signal);
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

  let imageDispatchCount = 0;

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
    expandHistoryItem,
    hosted: {
      hostedTypes: ['image_generation'],
      recognizeHostedTool: recognizeImageGenerationTool,
      buildFunctionTool: buildImageGenerationFunctionTool,
      dispatcher: ({ intercepted }, context) => {
        const promptArg = intercepted.parsedArguments !== null && typeof intercepted.parsedArguments.prompt === 'string'
          ? intercepted.parsedArguments.prompt
          : '';
        const id = synthesizeImageGenerationCallId();
        // Later ReAct turns include prior server-tool output in the live input.
        // Resolve and validate again so action:auto can pivot from generation
        // to editing without bypassing the same source policy used at ingress.
        // The per-request inspector cache reuses bytes already decoded during
        // registration and earlier turns.
        const operation = resolveImageOperation(materializedConfig, inspectSources(context.facts['openaiResponses'].input));
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
        const budgetExhausted = imageDispatchCount >= IMAGE_ITERATION_CAP;
        if (!budgetExhausted) imageDispatchCount += 1;

        return [{
          id,
          startItem: { type: 'image_generation_call', status: 'in_progress' },
          startEvents: [
            { type: 'response.image_generation_call.in_progress' },
            { type: 'response.image_generation_call.generating' },
          ],
          async *run() {
            return budgetExhausted
              ? imageTerminal(promptArg, 'generate', {
                  ok: false,
                  error: { type: 'image_generation_error', code: 'tool_call_budget_exhausted', message: `Image generation budget (${IMAGE_ITERATION_CAP} attempts) reached for this response. Summarize and finish without another image.`, retryable: false },
                })
              : yield* streamImageGeneration(promptArg, operation.action, sources, materializedConfig, context);
          },
        }];
      },
    },
  };
};
