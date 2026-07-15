import { compressBytesToWebp, type ImageSizeCalculator } from '@floway-dev/platform';

const BASE64_CHUNK = 0x8000;

export const base64ToBytes = (base64: string): Uint8Array<ArrayBuffer> => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK));
  }
  return btoa(binary);
};

const BASE64_DATA_URL = /^data:([^;,]+)(?:;[^,;]*)*;base64,(.*)$/is;

export const parseBase64ImageDataUrl = (url: string): { mimeType: string; base64: string } | null => {
  const match = BASE64_DATA_URL.exec(url);
  const mimeType = match?.[1];
  const base64 = match?.[2];
  return mimeType?.toLowerCase().startsWith('image/') && base64 !== undefined ? { mimeType, base64 } : null;
};

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

export const isBase64ImageDataUrl = (url: string): boolean =>
  parseBase64ImageDataUrl(url) !== null;

// Per-request memoizing wrappers around the compress helpers above. A single
// agentic request often replays the same screenshot across many turns, so the
// boundary interceptors run `Promise.all` over dozens of inline images that
// hash to the same cache key. Without dedup, every duplicate races a
// concurrent `kv.put`/sqlite UPDATE on that one key, which trips Cloudflare
// KV's per-key 1-write/sec limit and wastes work on the Node target. Only the
// memoized wrappers are exposed so a future caller cannot reintroduce the
// dedup gap by reaching for the unmemoized form. The returned function shares
// one in-flight compression per identical input for the lifetime of the
// wrapper — discard it after the request finishes.
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
