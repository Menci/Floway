import { compressBytesToWebp, type ImageSizeCalculator } from '@floway-dev/platform';
import { base64ToBytes, bytesToBase64, parseBase64ImageDataUrl } from '@floway-dev/provider';

const compressBase64ImageToWebp = async (
  base64: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const webp = await compressBytesToWebp(base64ToBytes(base64), calculator);
  return bytesToBase64(webp);
};

// Recompresses a `data:image/*;base64,...` URL to a WebP data URL. Returns the
// original URL unchanged when it is not a base64 image data URL (e.g. a remote
// https image reference, which the egress forwards as-is).
const compressImageDataUrlToWebp = async (
  url: string,
  calculator: ImageSizeCalculator,
): Promise<string> => {
  const parsed = parseBase64ImageDataUrl(url);
  if (parsed === null) return url;
  const webp = await compressBase64ImageToWebp(parsed.base64, calculator);
  return `data:image/webp;base64,${webp}`;
};

// A single agentic request often replays the same screenshot across many turns,
// so the boundary interceptors run `Promise.all` over dozens of inline images
// that hash to the same cache key. Without dedup, every duplicate races a
// concurrent cache write on that one key, tripping Cloudflare KV's per-key
// 1-write/sec limit and wasting work on the Node target. The returned function
// shares one in-flight compression per input for its lifetime.
const memoize = <TInput extends string, TOutput>(
  compute: (input: TInput) => Promise<TOutput>,
): ((input: TInput) => Promise<TOutput>) => {
  const cache = new Map<TInput, Promise<TOutput>>();
  return input => {
    let pending = cache.get(input);
    if (!pending) {
      pending = compute(input);
      cache.set(input, pending);
    }
    return pending;
  };
};

export const memoizedDataUrlCompressor = (
  calculator: ImageSizeCalculator,
): ((url: string) => Promise<string>) =>
  memoize(url => compressImageDataUrlToWebp(url, calculator));

export const memoizedBase64Compressor = (
  calculator: ImageSizeCalculator,
): ((base64: string) => Promise<string>) =>
  memoize(base64 => compressBase64ImageToWebp(base64, calculator));
