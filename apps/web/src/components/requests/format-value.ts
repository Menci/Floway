import { isDecodedSecret, isDecodedStreamRef } from '@floway-dev/pipeline/browser';

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const rawJsonText = (value: unknown): string | null => {
  if (!isRecord(value) || typeof value.rawJSON !== 'string') return null;
  const enhanced = JSON as typeof JSON & { readonly isRawJSON?: (candidate: unknown) => boolean };
  return Object.hasOwn(value, 'rawJSON') || enhanced.isRawJSON?.(value) === true ? value.rawJSON : null;
};

const base64Preview = (bytes: Uint8Array): string => {
  const preview = bytes.subarray(0, 96);
  let binary = '';
  for (let offset = 0; offset < preview.length; offset += 0x8000)
    binary += String.fromCharCode(...preview.subarray(offset, offset + 0x8000));
  return `${btoa(binary)}${bytes.byteLength > preview.byteLength ? '…' : ''}`;
};

const decodedBytes = (bytes: Uint8Array): unknown => {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const printable = [...text].every(character => {
      const code = character.codePointAt(0)!;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    });
    return printable ? text : { $bytes: `${bytes.byteLength} bytes`, base64: base64Preview(bytes) };
  } catch {
    return { $bytes: `${bytes.byteLength} bytes`, base64: base64Preview(bytes) };
  }
};

export const sanitizeDecodedForJson = (value: unknown): unknown => {
  const ancestors = new WeakSet<object>();
  const visit = (candidate: unknown): unknown => {
    if (isDecodedSecret(candidate)) {
      return {
        $secret: `${candidate.$secret.redacted} (len=${candidate.$secret.length}, sha256=${candidate.$secret.hash.slice(0, 12)})`,
      };
    }
    if (isDecodedStreamRef(candidate)) return { $stream: candidate.$stream };
    if (candidate instanceof Uint8Array) return decodedBytes(candidate);
    if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
    if (isRecord(candidate) && '$error' in candidate) return visit(candidate.$error);

    // JSON.rawJSON objects stringify to their number without a placeholder.
    // Reading the text here also preserves the decoder's polyfill shape.
    const raw = rawJsonText(candidate);
    if (raw !== null) {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return raw;
      }
    }

    if (typeof candidate !== 'object' || candidate === null) return candidate;
    if (ancestors.has(candidate)) return '[Circular]';
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(visit);
      const result: JsonRecord = {};
      for (const [key, child] of Object.entries(candidate)) result[key] = visit(child);
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return visit(value);
};

export const formatDecodedJson = (value: unknown): string =>
  value === undefined ? '' : JSON.stringify(sanitizeDecodedForJson(value), null, 2);

const SIMPLE_PATH_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export const formatDiffPath = (path: readonly (string | number)[]): string => {
  if (path.length === 0) return '$';
  let formatted = '';
  for (const [index, segment] of path.entries()) {
    if (typeof segment === 'number') {
      formatted += `[${segment}]`;
    } else if (SIMPLE_PATH_KEY.test(segment)) {
      formatted += index === 0 ? segment : `.${segment}`;
    } else {
      formatted += `[${JSON.stringify(segment)}]`;
    }
  }
  return formatted;
};

export const formatErrorValue = (error: unknown): string => {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`;
  if (isRecord(error) && '$error' in error) return formatErrorValue(error.$error);
  if (isRecord(error)) {
    const name = typeof error.name === 'string' ? error.name : null;
    const message = typeof error.message === 'string' ? error.message : null;
    const stack = typeof error.stack === 'string' ? error.stack : null;
    if (stack !== null) return stack;
    if (message !== null) return name === null ? message : `${name}: ${message}`;
  }
  return typeof error === 'object' && error !== null ? formatDecodedJson(error) : String(error);
};
