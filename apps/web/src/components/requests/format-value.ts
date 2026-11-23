import { isDecodedDeferredRef, isDecodedRawJson, isDecodedSecret, isDecodedStreamRef } from '@floway-dev/dump/browser';
import { Bytes } from '@floway-dev/pipeline/browser';
import { encodeBase64 } from '@floway-dev/protocols/browser';

type JsonRecord = Record<string, unknown>;

const decodedBytes = (value: Bytes): unknown => {
  const bytes = value.toUint8Array();
  const preview = () => ({ $bytes: bytes.byteLength, base64: encodeBase64(bytes.subarray(0, 96)) + (bytes.length > 96 ? '…' : '') });
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const printable = [...text].every(character => {
      const code = character.codePointAt(0)!;
      return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
    });
    return printable ? text : preview();
  } catch {
    return preview();
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
    if (isDecodedDeferredRef(candidate)) return { $deferred: candidate.$deferred };
    if (candidate instanceof Bytes) return decodedBytes(candidate);
    if (typeof candidate === 'bigint') return `${candidate.toString()}n`;
    if (typeof candidate === 'number' && !Number.isFinite(candidate)) return { $number: String(candidate) };
    if (Object.is(candidate, -0)) return { $number: '-0' };
    if (candidate === undefined) return { $undefined: true };

    if (isDecodedRawJson(candidate)) {
      const enhanced = JSON as typeof JSON & { readonly rawJSON?: (text: string) => unknown };
      if (enhanced.rawJSON !== undefined) return enhanced.rawJSON(candidate.rawJSON);
      try {
        return JSON.parse(candidate.rawJSON) as unknown;
      } catch {
        return candidate.rawJSON;
      }
    }

    if (typeof candidate !== 'object' || candidate === null) return candidate;
    if (ancestors.has(candidate)) return '[Circular]';
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) return candidate.map(visit);
      return Object.fromEntries(Object.entries(candidate).map(([key, child]) => [key, visit(child)]));
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
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const snapshot = error as JsonRecord;
    const name = typeof snapshot.name === 'string' ? snapshot.name : null;
    const message = typeof snapshot.message === 'string' ? snapshot.message : null;
    const stack = typeof snapshot.stack === 'string' ? snapshot.stack : null;
    if (stack !== null) return stack;
    if (message !== null) return name === null ? message : `${name}: ${message}`;
  }
  return typeof error === 'object' && error !== null ? formatDecodedJson(error) : String(error);
};
