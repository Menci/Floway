import { imageSize } from 'image-size';

export interface ImageDimensions {
  width: number;
  height: number;
}

export interface SizeCaps {
  maxLongEdge?: number;
  maxShortEdge?: number;
  maxArea?: number;
}

// Maps a source image's pixel dimensions to the dimensions the compressor
// should fit the output within. Returned dimensions are an upper bound — the
// compressor scales down to fit but never enlarges past the source. This is
// the one intentional knob the egress passes in: per-model tile budgets plug
// in here (see `fitWithin`) without the processor learning any model specifics.
export type ImageSizeCalculator = (source: ImageDimensions) => ImageDimensions;

// Fixed WebP quality for every recompressed inline image. 82 sits above the
// cwebp / photographic default of 75 so screenshots and text-heavy UI images —
// the bulk of Copilot traffic — survive our lossy pass before the upstream
// provider applies its own downscale and re-encode, while keeping the bandwidth
// win. Confirmed on real traffic: the production Cloudflare Images encoder at
// q82 matches local cwebp within <0.1 dB PSNR. References:
// - https://developers.google.com/speed/webp/docs/cwebp (default quality 75)
// - https://platform.claude.com/docs/en/build-with-claude/vision (multi-pass
//   compression warning)
// - https://getwebp.com/blog/screenshots-webp-settings-text-ui
export const WEBP_QUALITY = 82;

export interface ImageProcessor {
  // Re-encodes arbitrary raster image bytes to WebP at a fixed internal
  // quality, scaled to fit `target` (or encoded at source dimensions when target
  // is null, i.e. when the source dimensions could not be read locally). The target
  // is pre-resolved by the caller so implementations own only runtime encoding
  // and caching, not source inspection or model-specific sizing.
  compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array>;
}

// image-size both throws on unrecognised formats and returns undefined
// width/height for partial reads; we collapse both into a single null.
export const dimensionsFromBytes = (bytes: Uint8Array): ImageDimensions | null => {
  try {
    const { width, height } = imageSize(bytes);
    if (width === undefined || height === undefined) return null;
    return { width, height };
  } catch {
    return null;
  }
};

// Scales `source` DOWN (never up) to satisfy every present cap while preserving
// aspect ratio. This mirrors the server-side downscale each provider applies to
// images, so we never ship pixels the model would discard. With no caps the
// source passes through unchanged.
export const fitWithin = ({ width, height }: ImageDimensions, caps: SizeCaps): ImageDimensions => {
  const longEdge = Math.max(width, height);
  const shortEdge = Math.min(width, height);
  const factors = [1];
  if (caps.maxLongEdge !== undefined) factors.push(caps.maxLongEdge / longEdge);
  if (caps.maxShortEdge !== undefined) factors.push(caps.maxShortEdge / shortEdge);
  if (caps.maxArea !== undefined) factors.push(Math.sqrt(caps.maxArea / (width * height)));
  const scale = Math.min(...factors);
  if (scale >= 1) return { width, height };
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

let _imageProcessor: ImageProcessor | null = null;

export const initImageProcessor = (processor: ImageProcessor): void => {
  _imageProcessor = processor;
};

export const getImageProcessor = (): ImageProcessor => {
  if (!_imageProcessor) throw new Error('Image processor not initialized — call initImageProcessor() first');
  return _imageProcessor;
};

// Caller-side convenience that owns the "read source dims → run calculator →
// hand resolved target to the processor" responsibility chain.
export const compressBytesToWebp = async (
  bytes: Uint8Array,
  calculator: ImageSizeCalculator,
): Promise<Uint8Array> => {
  const source = dimensionsFromBytes(bytes);
  const target = source ? calculator(source) : null;
  return await getImageProcessor().compressToWebp(bytes, target);
};

// In-memory passthrough used by tests. There is no WebP codec available under
// the test runtime, so this stub returns the input bytes unchanged; it exists
// only to satisfy the ImageProcessor contract so the egress interceptors run
// end-to-end. Interceptor behaviour (which images are rewritten, what target
// is computed) is asserted against dedicated spy processors in the
// interceptor tests, not against this stub.
export const createInMemoryImageProcessor = (): ImageProcessor => ({
  compressToWebp: input => Promise.resolve(input),
});
