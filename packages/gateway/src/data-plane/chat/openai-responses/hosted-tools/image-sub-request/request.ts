import { getImageProcessor } from '@floway-dev/platform';
import { encodeHex } from '@floway-dev/protocols/common';
import type { CanonicalOpenAIImagesEditsRequest, CanonicalOpenAIImagesRequest } from '@floway-dev/protocols/openai-images';

// gpt-image-* `/images/edits` accepts only these input image mimetypes; a live
// Azure probe confirmed png/jpeg/webp succeed while gif is rejected with
// `unsupported_file_mimetype`. Native OpenAI Responses accepts the same GIF and
// re-encodes it before editing, so the dispatcher mirrors that behavior through the
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

export interface ImageBackendConfig {
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
  action: 'generate' | 'edit' | 'auto';
}

export interface ImageSource {
  bytes: Uint8Array<ArrayBuffer>;
  mimeType: string;
}
interface PreparedImageSource extends ImageSource { mimeType: EditMime }

export interface ImageGenerationRequest {
  prompt: string;
  action: 'generate' | 'edit';
  config: ImageBackendConfig & { mask?: ImageSource };
  sources: readonly ImageSource[];
}

const prepareEditSources = async (sources: readonly ImageSource[]): Promise<readonly PreparedImageSource[]> => {
  const keyBySource = new Map<ImageSource, Promise<string>>();
  const preparedByContent = new Map<string, Promise<PreparedImageSource>>();
  return await Promise.all(sources.map(async source => {
    const mimeType = editSupportedMime(source.mimeType);
    if (mimeType !== null) return { bytes: source.bytes, mimeType };

    let keyPromise = keyBySource.get(source);
    if (keyPromise === undefined) {
      keyPromise = crypto.subtle.digest('SHA-256', source.bytes).then(buffer => {
        const digest = encodeHex(new Uint8Array(buffer));
        return `${source.mimeType}\u0000${digest}`;
      });
      keyBySource.set(source, keyPromise);
    }
    const key = await keyPromise;

    let prepared = preparedByContent.get(key);
    if (prepared === undefined) {
      // Native OpenAI Responses accepts formats such as GIF through its multimodal
      // preprocessing, while the standalone edits endpoint accepts only
      // PNG/JPEG/WebP. Re-encode locally to preserve the hosted-tool behavior.
      // https://github.com/openai/openai-node/blob/ec2f57fd0d66e94782656b986d7b3eb03225369c/src/resources/images.ts#L560-L572
      prepared = getImageProcessor().compressToWebp(source.bytes, null).then(encoded => {
        const bytes = new Uint8Array(encoded);
        return { bytes, mimeType: 'image/webp' } satisfies PreparedImageSource;
      });
      preparedByContent.set(key, prepared);
    }
    return await prepared;
  }));
};

const prepareEditRequest = async (
  sources: readonly ImageSource[],
  config: ImageBackendConfig & { mask?: ImageSource },
): Promise<{ sources: readonly PreparedImageSource[]; mask?: PreparedImageSource }> => {
  const originals = [...sources];
  if (config.mask !== undefined && !originals.includes(config.mask)) originals.push(config.mask);
  const prepared = await prepareEditSources(originals);
  return {
    sources: prepared.slice(0, sources.length),
    ...(config.mask === undefined ? {} : { mask: prepared[originals.indexOf(config.mask)]! }),
  };
};

const buildGenerationsBody = (prompt: string, config: ImageBackendConfig, stream: boolean): Record<string, unknown> => ({
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
  config: ImageBackendConfig,
  sources: readonly PreparedImageSource[],
  mask: PreparedImageSource | undefined,
  stream: boolean,
): CanonicalOpenAIImagesEditsRequest => {
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
    kind: 'file' as const,
    file: { bytes: source.bytes, fileName: `image_${index}.${editFileExt(source.mimeType)}`, mediaType: source.mimeType },
  }));
  const maskFile = mask === undefined
    ? undefined
    : { bytes: mask.bytes, fileName: `mask.${editFileExt(mask.mimeType)}`, mediaType: mask.mimeType };
  return {
    operation: 'edits',
    images,
    ...(maskFile === undefined ? {} : { mask: { kind: 'file' as const, file: maskFile } }),
    parameters,
  };
};

export const prepareImageRequest = async (request: ImageGenerationRequest): Promise<CanonicalOpenAIImagesRequest> => {
  const { prompt, config } = request;
  const stream = (config.partial_images ?? 0) > 0;
  if (request.action === 'generate') return { operation: 'generations', parameters: buildGenerationsBody(prompt, config, stream) };
  const prepared = await prepareEditRequest(request.sources, config);
  return buildEditsRequest(prompt, config, prepared.sources, prepared.mask, stream);
};

export const portableImageRequest = (
  prompt: string,
  action: 'generate' | 'edit',
  config: ImageBackendConfig & { mask?: { bytes: ArrayBuffer; mimeType: string } },
  sources: readonly { bytes: ArrayBuffer; mimeType: string }[],
): ImageGenerationRequest => {
  const converted = new Map<object, ImageSource>();
  const convert = (source: { bytes: ArrayBuffer; mimeType: string }): ImageSource => {
    let portable = converted.get(source);
    if (portable === undefined) {
      portable = { bytes: new Uint8Array(source.bytes), mimeType: source.mimeType };
      converted.set(source, portable);
    }
    return portable;
  };
  const { mask, ...parameters } = config;
  return {
    prompt, action,
    config: { ...parameters, ...(mask === undefined ? {} : { mask: convert(mask) }) },
    sources: sources.map(convert),
  };
};
