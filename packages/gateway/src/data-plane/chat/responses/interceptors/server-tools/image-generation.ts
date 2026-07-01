import { sleep } from '../../../../../shared/sleep.ts';
import { enumerateModelCandidates } from '../../../../providers/registry.ts';
import { appendFailedUpstreams } from '../../../../shared/failed-upstreams.ts';
import { createUpstreamLatencyRecorder, recordPerformanceError, recordPerformanceLatency, requireRecordedDurationMs } from '../../../../shared/telemetry/performance.ts';
import { recordTokenUsage, tokenUsageFromImagesBody } from '../../../../shared/telemetry/usage.ts';
import type { ServerToolLifecycleEvent, ServerToolOutputItem, ServerToolRegistration, ServerToolTerminal } from '../server-tool-shim.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { parseSSEStream } from '@floway-dev/protocols/common';
import type {
  ResponsesFunctionCallOutputItem,
  ResponsesFunctionTool,
  ResponsesFunctionToolCallItem,
  ResponsesHostedTool,
  ResponsesInputContent,
  ResponsesInputImageGenerationCall,
  ResponsesInputItem,
  ResponsesOutputImageGenerationCall,
  ResponsesTool,
} from '@floway-dev/protocols/responses';
import { providerModelOf, type Fetcher, type Provider, type PerformanceTelemetryContext, type ModelCandidate, type ProviderModel } from '@floway-dev/provider';

export const SHIM_TOOL_NAME = 'image_generation';

// Default image backend when the hosted tool omits `model`. gpt-image-2 is
// the reference backend Azure's native Responses `image_generation` routes
// to; operators provision it under this public id (or alias it).
export const DEFAULT_IMAGE_MODEL = 'gpt-image-2';

// Safety valve on the multi-turn ReAct loop: cap how many real image backend
// calls one response may dispatch (counted on `ShimState.imageDispatchCount`,
// not the shared ReAct turn count, so unrelated turns do not consume the
// budget). Past the cap the dispatcher replays an exhausted-budget tool output
// instead of hitting the backend, so a model that keeps retrying after failures
// cannot drive unbounded image cost.
const IMAGE_ITERATION_CAP = 10;

// Public Responses `image_generation` tool config enums (Azure-strict
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

// gpt-image-* `/images/edits` accepts only these input image mimetypes; probing
// Azure confirmed png/jpeg/webp succeed while gif/bmp/tiff are rejected with
// `unsupported_file_mimetype`. The backend gates on the multipart content-type
// before it decodes the bytes, so the mime we forward must already be one of
// these. Common aliases are folded onto the canonical form the backend expects.
const EDIT_MIME_ALIASES: Record<string, string> = {
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/x-png': 'image/png',
};
const EDIT_SUPPORTED_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp']);

// The canonical edit-supported mimetype for a source, or null when gpt-image
// edit cannot accept the format. Native Responses runs the input through its
// multimodal pipeline and re-encodes it, so it edits e.g. a gif input that
// this endpoint would reject; we forward bytes verbatim and have no image
// codec available through @floway-dev/platform contracts, so an unsupported
// format is rejected up front.
const editSupportedMime = (mime: string): string | null => {
  const canonical = EDIT_MIME_ALIASES[mime] ?? mime;
  return EDIT_SUPPORTED_MIMES.has(canonical) ? canonical : null;
};

const editFileExt = (mime: string): string =>
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

export const isHostedImageGenerationTool = (tool: ResponsesTool): tool is ResponsesHostedTool =>
  tool.type === 'image_generation';

// Identity canonicalization for image_generation: the shim doesn't
// depend on filled defaults to run, and the OpenAI spec defaults for
// `background` / `quality` / `size` / etc. observed via Azure echo
// (all `'auto'`) signal "backend decides" rather than concrete values
// the model needs. Preserving the client's raw shape keeps the echo
// round-trip minimal — anything the client didn't send stays absent.
export const canonicalizeImageGenerationTool = (raw: ResponsesTool): ResponsesHostedTool | undefined =>
  isHostedImageGenerationTool(raw) ? raw : undefined;

// A base64-data-URL or bare-base64 image source bound for an edit call.
// Bytes are held in a concrete ArrayBuffer so they can be wrapped in a Blob.
interface ImageSource {
  bytes: ArrayBuffer;
  mimeType: string;
}

const base64ToArrayBuffer = (b64: string): ArrayBuffer => {
  const binary = atob(b64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return buffer;
};

// Parse a `data:<mime>;base64,<payload>` URL or a bare base64 string (as
// emitted in `image_generation_call.result`) into raw bytes. Returns null
// for non-data URLs (e.g. http(s)): fetching remote images at edit time is
// not supported — only inline image bytes are accepted.
const decodeInlineImage = (imageUrl: string, fallbackMime = 'image/png'): ImageSource | null => {
  const dataUrlMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
  if (dataUrlMatch === null) {
    if (/^https?:\/\//i.test(imageUrl)) return null;
    try {
      return { bytes: base64ToArrayBuffer(imageUrl), mimeType: fallbackMime };
    } catch {
      return null;
    }
  }
  const isBase64 = dataUrlMatch[2] !== undefined;
  const payload = dataUrlMatch[3];
  if (!isBase64) return null;
  try {
    return { bytes: base64ToArrayBuffer(payload), mimeType: dataUrlMatch[1] ?? fallbackMime };
  } catch {
    return null;
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
  // Inpainting mask decoded once at validation, forwarded to /images/edits as
  // the standalone `mask` part. `file_id` masks are not supported (rejected at
  // validation) — resolving them needs the files API.
  mask?: ImageSource;
  action: 'generate' | 'edit' | 'auto';
}

interface PrepareConfigError {
  message: string;
  param: string;
  code: 'unknown_parameter' | 'invalid_value' | 'integer_below_min_value' | 'integer_above_max_value';
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

// Validate one hosted `image_generation` entry against the public Responses
// surface and project it into the shim's config. Every hosted entry is
// validated (not just the last) so an earlier entry's bad field is rejected
// rather than masked by a later valid one — matching Azure's per-entry
// strictness with concrete `tools[i].field` paths.
const validateHostedImageGenerationEntry = (
  tool: ResponsesHostedTool,
  index: number,
): { ok: true; config: ImageGenerationConfig } | { ok: false; error: PrepareConfigError } => {
  const path = (field: string): string => `tools[${index}].${field}`;

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

  // input_image_mask: inpainting mask. Accept an inline `image_url`
  // (data URL / base64) and validate that it decodes; `file_id` masks need
  // the files API to resolve to bytes and are not supported here. Reject a
  // malformed or unsupported mask rather than silently dropping the mask the
  // client expected to apply.
  const maskField = tool.input_image_mask;
  let mask: ImageSource | undefined;
  if (maskField !== undefined && maskField !== null) {
    if (typeof maskField !== 'object' || Array.isArray(maskField)) {
      return { ok: false, error: invalidValue(path('input_image_mask'), maskField, ['{ image_url }']) };
    }
    const maskUrl = (maskField as { image_url?: unknown }).image_url;
    if (typeof maskUrl !== 'string' || maskUrl.length === 0) {
      return {
        ok: false,
        error: { message: 'image_generation input_image_mask requires an inline `image_url`; `file_id` masks are not supported by this gateway.', param: path('input_image_mask'), code: 'invalid_value' },
      };
    }
    const decodedMask = decodeInlineImage(maskUrl);
    if (decodedMask === null) {
      return {
        ok: false,
        error: { message: 'image_generation input_image_mask.image_url must be an inline base64 data URL; remote URLs and malformed base64 are not supported.', param: path('input_image_mask'), code: 'invalid_value' },
      };
    }
    mask = decodedMask;
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

// Validate every hosted `image_generation` entry; the LAST entry's config
// wins (most-recent declaration).
export const prepareImageGenerationConfig = (tools: readonly ResponsesTool[]): PrepareConfigResult => {
  let config: ImageGenerationConfig | undefined;
  for (const [i, tool] of tools.entries()) {
    if (!isHostedImageGenerationTool(tool)) continue;
    const validated = validateHostedImageGenerationEntry(tool, i);
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
export const buildImageGenerationFunctionTool = (_canonical: ResponsesHostedTool, name: string): ResponsesFunctionTool => ({
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
  `ig_gw_${crypto.randomUUID().replace(/-/g, '')}`;

// Collect all inline image sources from the request input in forward
// declaration order: `input_image` blocks in messages, `input_image` blocks in
// `function_call_output` (tool-result) content, and full-echo
// `image_generation_call` items carrying `result` bytes, each in the order they
// appear. Order is load-bearing: probing both the standalone /images/edits
// endpoint and native Responses showed gpt-image numbers the attached images
// positionally — a prompt that says "the first/second/last image" resolves
// against the order received — and native flattens every image across messages
// and tool results into this same forward order. Preserving declaration order
// therefore makes "the Nth image" mean the same thing here as it does natively.
export const collectImageSources = (input: readonly ResponsesInputItem[]): ImageSource[] => {
  const sources: ImageSource[] = [];
  const collectFromContent = (content: string | ResponsesInputContent[]): void => {
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'input_image' && typeof block.image_url === 'string') {
        const decoded = decodeInlineImage(block.image_url);
        if (decoded !== null) sources.push(decoded);
      }
    }
  };
  for (const item of input) {
    if (item.type === 'message') {
      collectFromContent(item.content);
      continue;
    }
    // A tool result may carry images as structured `input_image` content; read
    // them so a tool-returned image is editable, matching native's flattening.
    if (item.type === 'function_call_output') {
      collectFromContent(item.output);
      continue;
    }
    if (item.type === 'image_generation_call' && typeof item.result === 'string' && item.result.length > 0) {
      // A prior generated image carries no MIME prefix on its bare-base64
      // `result`; pick the fallback from the echoed `output_format` so a
      // JPEG output is not mislabeled PNG on the edit form.
      const fallbackMime = item.output_format === 'jpeg' ? 'image/jpeg' : 'image/png';
      const decoded = decodeInlineImage(item.result, fallbackMime);
      if (decoded !== null) sources.push(decoded);
    }
  }
  return sources;
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

const errorFromBody = (body: string, status: number): { type?: string; code: string; message: string } => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown; type?: unknown } };
    const err = parsed.error;
    if (err !== undefined && err !== null) {
      return {
        ...(typeof err.type === 'string' ? { type: err.type } : {}),
        message: typeof err.message === 'string' ? err.message : `Image backend returned HTTP ${status}`,
        code: typeof err.code === 'string' ? err.code : `upstream_${status}`,
      };
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  return { message: `Image backend returned HTTP ${status}`, code: `upstream_${status}` };
};

// Per-request inputs the dispatcher's backend call needs. Captured in the
// registration closure from `ctx`/`request` so the dispatcher stays free of the
// interceptor signature. Edit sources are NOT captured here — they are
// re-collected from the live `ctx.payload.input` at dispatch time so an image
// generated in an earlier turn (fed back as an `input_image`) becomes editable
// in a later turn. `imageDispatchCount` bounds how many real backend image
// calls one response may issue.
interface ShimState {
  config: ImageGenerationConfig;
  apiKeyId: string;
  upstreamIds: readonly string[] | null;
  backgroundScheduler: BackgroundScheduler;
  runtimeLocation: string;
  currentColo: string;
  downstreamAbortSignal: AbortSignal | undefined;
  imageDispatchCount: number;
}

const recordImageUsage = (state: ShimState, provider: Provider, model: ProviderModel, modelKey: string, responseBody: unknown): void => {
  const usage = tokenUsageFromImagesBody(responseBody);
  if (usage === null) return;
  const promise = recordTokenUsage(state.apiKeyId, {
    model: model.id,
    upstream: provider.upstream,
    modelKey,
    cost: provider.instance.getPricingForModelKey(modelKey) ?? null,
  }, usage).catch((error: unknown) => {
    console.error('Failed to record image generation usage:', error);
  });
  state.backgroundScheduler(promise);
};

export const buildGenerationsBody = (prompt: string, config: ImageGenerationConfig, stream: boolean): Record<string, unknown> => ({
  prompt,
  // Public Responses tool config forbids `n`, but the private standalone
  // backend call always requests a single image, mirroring Azure's
  // single-image Responses behavior.
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

const buildEditsForm = (prompt: string, config: ImageGenerationConfig, sources: readonly ImageSource[], stream: boolean): FormData => {
  const form = new FormData();
  form.append('prompt', prompt);
  form.append('n', '1');
  if (config.size !== undefined) form.append('size', config.size);
  if (config.quality !== undefined) form.append('quality', config.quality);
  if (config.output_format !== undefined) form.append('output_format', config.output_format);
  if (config.background !== undefined) form.append('background', config.background);
  if (config.moderation !== undefined) form.append('moderation', config.moderation);
  if (config.output_compression !== undefined) form.append('output_compression', String(config.output_compression));
  if (config.input_fidelity !== undefined) form.append('input_fidelity', config.input_fidelity);
  if (stream) {
    form.append('stream', 'true');
    form.append('partial_images', String(config.partial_images));
  }
  for (const [i, source] of sources.entries()) {
    // Forward the canonical supported mime; an unsupported source is rejected
    // before dispatch, so the fallback only ever carries an already-supported
    // generated image. Sending the raw mime (rather than relabeling as png)
    // keeps a stray unsupported byte stream failing loud at the backend.
    const mime = editSupportedMime(source.mimeType) ?? source.mimeType;
    // `image[]` repeated parts: gpt-image accepts multiple, resolving "the
    // Nth image" against attach order (see `collectImageSources`).
    form.append('image[]', new Blob([source.bytes], { type: mime }), `image_${i}.${editFileExt(mime)}`);
  }
  if (config.mask !== undefined) {
    const mime = editSupportedMime(config.mask.mimeType) ?? config.mask.mimeType;
    form.append('mask', new Blob([config.mask.bytes], { type: mime }), `mask.${editFileExt(mime)}`);
  }
  return form;
};

const serverError = (e: unknown): ImageError => ({
  type: 'image_generation_error',
  message: e instanceof Error ? e.message : String(e),
  code: 'server_error',
  retryable: true,
});

// Resolve the candidate that serves the configured image model for the
// target endpoint. A resolution/availability failure is normalized into
// an `ImageError` so the caller always produces a terminal image item.
const resolveImageCandidate = async (
  isEdit: boolean,
  state: ShimState,
): Promise<{ ok: true; candidate: ModelCandidate } | { ok: false; error: ImageError }> => {
  const endpointKey = isEdit ? 'imagesEdits' : 'imagesGenerations';
  const endpointPath = isEdit ? '/images/edits' : '/images/generations';
  let resolution;
  try {
    resolution = await enumerateModelCandidates({
      upstreamIds: state.upstreamIds,
      model: state.config.model,
      kind: 'image',
      scheduler: state.backgroundScheduler,
      currentColo: state.currentColo,
    });
  } catch (e) {
    return { ok: false, error: serverError(e) };
  }
  const match = resolution.candidates.find(c => c.model.endpoints[endpointKey] !== undefined);
  if (match !== undefined) {
    return { ok: true, candidate: match };
  }
  // Split on the resolver's `sawModel` signal the same way serve-prep.ts
  // does for chat: an unknown model id ("model_not_found", 404-shaped) vs
  // a model that exists under some catalog but cannot serve this op
  // ("model_not_supported"). The latter splits further on whether the
  // resolver's kind filter rejected the id (sawModel=true, candidates=[]:
  // id exists but not as an image model) or the per-endpoint key did
  // (candidates non-empty: image-kind upstreams exist but none expose the
  // requested edits/generations endpoint).
  if (!resolution.sawModel) {
    return {
      ok: false,
      error: {
        type: 'image_generation_error',
        message: appendFailedUpstreams(`No upstream provides model '${state.config.model}'.`, resolution.failedUpstreams),
        code: 'model_not_found',
        retryable: false,
      },
    };
  }
  const message = resolution.candidates.length === 0
    ? `Model '${state.config.model}' is not an image model.`
    : `No upstream supporting the ${endpointPath} endpoint provides model '${state.config.model}'.`;
  return {
    ok: false,
    error: {
      type: 'image_generation_error',
      message: appendFailedUpstreams(message, resolution.failedUpstreams),
      code: 'model_not_supported',
      retryable: false,
    },
  };
};

// 60s cap matches the per-minute refill window of Azure TPM/RPM and
// openai.com tier image quotas — same clamp openai-python applies in
// [`_calculate_retry_timeout`](https://github.com/openai/openai-python/blob/d76d8c11c1da9f97aa8a0aaee8ccd44d2bc8f5e7/src/openai/_base_client.py#L789).
const RETRY_CAP_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 2;

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

// The image-generation sub-call is a real upstream HTTP request that lands
// under its own `(model, upstream, modelKey)` dimensions in
// `upstream_success` — distinct from the outer Responses orchestrator's
// recording. Each attempt of the 429-retry loop records on its own; the
// intermediate failures land as error counters and the final outcome's
// latency (success or failure) is the one operators see at the dimension.
// On 429, sleep for the upstream's retry hint (or jittered exponential
// backoff when absent) and replay the same backend call up to
// MAX_RATE_LIMIT_RETRIES times. The returned `response` always has a fresh,
// unread body — intermediate failed responses are drained inside the loop so
// the underlying socket can be reused while we sleep.
const issueImageCall = async (
  provider: Provider,
  model: ProviderModel,
  fetcher: Fetcher,
  prompt: string,
  isEdit: boolean,
  sources: readonly ImageSource[],
  state: ShimState,
  stream: boolean,
): Promise<{ response: Response; modelKey: string }> => {
  for (let attempt = 0; ; attempt++) {
    const recorder = createUpstreamLatencyRecorder();
    const opts = {
      fetcher,
      recordUpstreamLatency: recorder.record,
      waitUntil: state.backgroundScheduler,
      headers: new Headers(),
    };
    const { response, modelKey } = await (isEdit
      ? provider.instance.callImagesEdits(model, buildEditsForm(prompt, state.config, sources, stream), state.downstreamAbortSignal, opts)
      : provider.instance.callImagesGenerations(model, buildGenerationsBody(prompt, state.config, stream), state.downstreamAbortSignal, opts));
    const context: PerformanceTelemetryContext = {
      keyId: state.apiKeyId,
      model: model.id,
      upstream: provider.upstream,
      modelKey,
      stream: false,
      runtimeLocation: state.runtimeLocation,
    };
    if (response.ok) {
      const durationMs = requireRecordedDurationMs(recorder, isEdit ? 'callImagesEdits' : 'callImagesGenerations');
      state.backgroundScheduler(recordPerformanceLatency(context, 'upstream_success', durationMs));
    } else {
      state.backgroundScheduler(recordPerformanceError(context, 'upstream_success'));
    }
    if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return { response, modelKey };

    // 25% jitter desynchronizes parallel callers so a burst of orchestrator
    // turns doesn't all re-issue at the same instant.
    const base = 1000 * 2 ** attempt;
    const backoffMs = base + Math.random() * base * 0.25;
    const delayMs = Math.min(parseRetryAfterMs(response.headers) ?? backoffMs, RETRY_CAP_MS);
    await response.text().catch(() => undefined);
    await sleep(delayMs, state.downstreamAbortSignal);
  }
};

// Consume a non-streaming backend response (partial_images = 0) into an
// outcome. Transport/backend failures become `{ok:false}` rather than
// throwing, so the caller always produces a terminal image item.
const consumeImageResponse = async (
  provider: Provider,
  model: ProviderModel,
  modelKey: string,
  response: Response,
  state: ShimState,
): Promise<ImageOutcome> => {
  const text = await response.text();
  if (!response.ok) {
    const { type, code, message } = errorFromBody(text, response.status);
    return { ok: false, error: { type: type ?? 'image_generation_error', code, message, retryable: isRetryableImageError(code, type) } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: { type: 'image_generation_error', message: 'Image backend returned a non-JSON success body.', code: 'server_error', retryable: true } };
  }
  const b64 = (() => {
    if (parsed === null || typeof parsed !== 'object') return null;
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return null;
    const first = data[0] as { b64_json?: unknown };
    return typeof first.b64_json === 'string' ? first.b64_json : null;
  })();
  if (b64 === null) {
    return { ok: false, error: { type: 'image_generation_error', message: 'Image backend response did not contain image bytes.', code: 'server_error', retryable: true } };
  }
  recordImageUsage(state, provider, model, modelKey, parsed);
  return { ok: true, b64, echo: extractEcho(parsed) };
};

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
): ServerToolTerminal => {
  if (!outcome.ok) {
    const item: ServerToolOutputItem & Omit<ResponsesOutputImageGenerationCall, 'id'> = {
      type: 'image_generation_call',
      status: 'failed',
      revised_prompt: prompt,
      error: { message: outcome.error.message, code: outcome.error.code, type: outcome.error.type },
    };
    return { item, endEvents: [] };
  }

  const item: ServerToolOutputItem & Omit<ResponsesOutputImageGenerationCall, 'id'> = {
    type: 'image_generation_call',
    status: 'completed',
    action,
    result: outcome.b64,
    revised_prompt: prompt,
    ...outcome.echo,
  };
  return { item, endEvents: [{ type: 'response.image_generation_call.completed' }] };
};

// One standalone-images SSE data line, folded into a backend-agnostic signal.
// The generations and edits endpoints use distinct event prefixes
// (`image_generation.*` vs `image_edit.*`); only the suffix is matched here.
type ImageStreamSignal =
  | { kind: 'partial'; index: number; b64: string; echo: EchoFields }
  | { kind: 'completed'; b64: string | undefined; usage: unknown; echo: EchoFields }
  | { kind: 'error'; error: ImageError }
  | null;

export const parseImageStreamEvent = (data: string): ImageStreamSignal => {
  let evt: { type?: unknown; partial_image_index?: unknown; b64_json?: unknown; usage?: unknown; error?: unknown };
  try {
    evt = JSON.parse(data);
  } catch {
    return null;
  }
  const type = typeof evt.type === 'string' ? evt.type : '';
  if (type.endsWith('.partial_image')) {
    return {
      kind: 'partial',
      index: typeof evt.partial_image_index === 'number' ? evt.partial_image_index : 0,
      b64: typeof evt.b64_json === 'string' ? evt.b64_json : '',
      echo: extractEcho(evt),
    };
  }
  if (type.endsWith('.completed')) {
    return { kind: 'completed', b64: typeof evt.b64_json === 'string' ? evt.b64_json : undefined, usage: evt.usage, echo: extractEcho(evt) };
  }
  if (type === 'error') {
    const err = evt.error as { message?: unknown; code?: unknown; type?: unknown } | undefined;
    const code = typeof err?.code === 'string' ? err.code : 'server_error';
    const errType = typeof err?.type === 'string' ? err.type : 'image_generation_error';
    return {
      kind: 'error',
      error: { type: errType, code, message: typeof err?.message === 'string' ? err.message : 'Image backend stream reported an error.', retryable: isRetryableImageError(code, errType) },
    };
  }
  return null;
};

// Drive the backend and produce the deferred slot lifecycle: relay each
// progressively-rendered preview as a native `partial_image` frame, then
// return the terminal `image_generation_call` item. partial_images = 0 (or
// absent) takes a single non-streaming round-trip and yields no preview frames.
const streamImageGeneration = (
  prompt: string,
  action: 'generate' | 'edit',
  isEdit: boolean,
  sources: readonly ImageSource[],
  state: ShimState,
) => async function* (): AsyncGenerator<ServerToolLifecycleEvent, ServerToolTerminal> {
  const resolved = await resolveImageCandidate(isEdit, state);
  if (!resolved.ok) return imageTerminal(prompt, action, { ok: false, error: resolved.error });
  const { provider, fetcher } = resolved.candidate;
  const model = providerModelOf(resolved.candidate);
  const wantsPartials = (state.config.partial_images ?? 0) > 0;

  let response: Response;
  let modelKey: string;
  try {
    ({ response, modelKey } = await issueImageCall(provider, model, fetcher, prompt, isEdit, sources, state, wantsPartials));
  } catch (e) {
    return imageTerminal(prompt, action, { ok: false, error: serverError(e) });
  }

  if (!wantsPartials) {
    return imageTerminal(prompt, action, await consumeImageResponse(provider, model, modelKey, response, state));
  }

  if (!response.ok) {
    const { type, code, message } = errorFromBody(await response.text(), response.status);
    return imageTerminal(prompt, action, { ok: false, error: { type: type ?? 'image_generation_error', code, message, retryable: isRetryableImageError(code, type) } });
  }
  if (response.body === null) {
    return imageTerminal(prompt, action, { ok: false, error: { type: 'image_generation_error', message: 'Image backend returned a streaming response with no body.', code: 'server_error', retryable: true } });
  }

  let finalB64: string | undefined;
  let finalEcho: EchoFields = {};
  let usage: unknown;
  for await (const frame of parseSSEStream(response.body, { signal: state.downstreamAbortSignal })) {
    const signal = parseImageStreamEvent(frame.data);
    if (signal === null) continue;
    if (signal.kind === 'partial') {
      yield { type: 'response.image_generation_call.partial_image', partial_image_index: signal.index, partial_image_b64: signal.b64, ...signal.echo };
    } else if (signal.kind === 'completed') {
      finalB64 = signal.b64;
      finalEcho = signal.echo;
      usage = signal.usage;
    } else {
      return imageTerminal(prompt, action, { ok: false, error: signal.error });
    }
  }
  if (finalB64 === undefined) {
    return imageTerminal(prompt, action, { ok: false, error: { type: 'image_generation_error', message: 'Image backend stream ended without a completed image.', code: 'server_error', retryable: true } });
  }
  recordImageUsage(state, provider, model, modelKey, { usage });
  return imageTerminal(prompt, action, { ok: true, b64: finalB64, echo: finalEcho });
};

// Output-as-input round-trip: the multi-turn loop feeds accumulated
// `image_generation_call` items back as the next turn's input, and client
// histories may echo prior ones. Non-Responses upstreams can't read the item
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
// carries the full result payload — collectImageSources can bind result bytes
// directly without any out-of-band lookup. The `image_generation_call` shape
// needs no out-of-band payload for this to be lossless: every field required
// to rebuild the pair, INCLUDING the error (`status` + `error{message,code,
// type}`), has a public home on the item.
export const transformInputItemsForImageGeneration = (
  input: ResponsesInputItem[],
  toolName: string,
): ResponsesInputItem[] => {
  const out: ResponsesInputItem[] = [];
  for (const item of input) {
    if (item.type !== 'image_generation_call') {
      out.push(item);
      continue;
    }
    const ig = item as ResponsesInputImageGenerationCall;
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
    const functionCall: ResponsesFunctionToolCallItem = {
      type: 'function_call',
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify({ prompt: ig.revised_prompt ?? '' }),
      status: 'completed',
    };
    const functionCallOutput: ResponsesFunctionCallOutputItem = {
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

export const imageGenerationServerTool: ServerToolRegistration = (invocation, gatewayCtx) => {
  if (invocation.targetApi === 'responses' && !providerModelOf(invocation.candidate).enabledFlags.has('responses-image-generation-shim')) {
    return { type: 'inactive' };
  }

  const tools = Array.isArray(invocation.payload.tools) ? invocation.payload.tools : [];
  const hasHostedTool = tools.some(isHostedImageGenerationTool);
  const hasReplayInput = invocation.payload.input.some(i => i.type === 'image_generation_call');
  if (!hasHostedTool && !hasReplayInput) return { type: 'inactive' };

  if (!hasHostedTool) {
    // Replay-only activation: rewrite echoed image_generation_call items so
    // the upstream can read them, but there is no hosted tool to dispatch.
    return {
      type: 'active',
      baseToolName: SHIM_TOOL_NAME,
      transformItems: transformInputItemsForImageGeneration,
    };
  }

  const prepared = prepareImageGenerationConfig(tools);
  if (!prepared.ok) {
    return { type: 'invalid-request', message: prepared.error.message, param: prepared.error.param, code: prepared.error.code };
  }
  const config = prepared.config;
  const originalImageSources = collectImageSources(invocation.payload.input);

  // `action:"edit"` with no bindable image is a client request-shape error,
  // surfaced before the model loop because it is not a runtime backend
  // failure.
  if (config.action === 'edit' && originalImageSources.length === 0) {
    return {
      type: 'invalid-request',
      message: 'image_generation action "edit" requires at least one input image, but none was found in the request input.',
      param: 'input',
      code: 'invalid_value',
    };
  }

  // gpt-image edit only accepts png/jpeg/webp inputs; reject an unsupported
  // format up front (Azure-strict `unsupported_file_mimetype`) when the request
  // could edit. action:"generate" never forwards input images to the backend,
  // so their format is irrelevant there. Generated images fed back in later
  // turns are always png/jpeg, so validating the original request input here
  // covers every client-supplied source. See `editSupportedMime` for why an
  // unsupported format is rejected rather than transcoded.
  if (config.action !== 'generate') {
    for (const source of originalImageSources) {
      if (editSupportedMime(source.mimeType) === null) {
        return {
          type: 'invalid-request',
          message: `image_generation input image format '${source.mimeType}' is not supported for editing. Supported formats are 'image/png', 'image/jpeg', and 'image/webp'. Set the tool's action to "generate" if the image is only context.`,
          param: 'input',
          code: 'unsupported_file_mimetype',
        };
      }
    }
  }

  // A mask only applies to an edit; with action:"generate" it could never be
  // used, so reject rather than silently dropping it.
  if (config.mask !== undefined && config.action === 'generate') {
    return {
      type: 'invalid-request',
      message: 'image_generation input_image_mask is only valid for an edit; do not force action "generate" when supplying a mask.',
      param: 'tools',
      code: 'invalid_value',
    };
  }

  const state: ShimState = {
    config,
    apiKeyId: gatewayCtx.apiKeyId,
    upstreamIds: gatewayCtx.upstreamIds,
    backgroundScheduler: gatewayCtx.backgroundScheduler,
    runtimeLocation: gatewayCtx.runtimeLocation,
    currentColo: gatewayCtx.currentColo,
    downstreamAbortSignal: gatewayCtx.abortSignal,
    imageDispatchCount: 0,
  };

  return {
    type: 'active',
    baseToolName: SHIM_TOOL_NAME,
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

        // Re-collect edit sources from the live input so an image generated in
        // an earlier turn (fed back as an `input_image`) is editable now, and
        // resolve edit-vs-generate against the current sources for action:auto.
        const sources = collectImageSources(invocation.payload.input);
        const isEdit = config.action === 'edit' || (config.action === 'auto' && sources.length > 0);
        const action: 'generate' | 'edit' = isEdit ? 'edit' : 'generate';

        return [{
          id,
          startItem: { type: 'image_generation_call', status: 'in_progress' },
          startEvents: [
            { type: 'response.image_generation_call.in_progress' },
            { type: 'response.image_generation_call.generating' },
          ],
          run: streamImageGeneration(promptArg, action, isEdit, sources, state),
        }];
      },
    },
  };
};
