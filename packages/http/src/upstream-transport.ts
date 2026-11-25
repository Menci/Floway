import { isCausedBy } from './abort.ts';
import type { ProviderFetchResult } from './types.ts';

export class UpstreamTransportError extends Error {
  override readonly name = 'UpstreamTransportError';

  constructor(cause: unknown, message = cause instanceof Error ? cause.message : String(cause)) {
    super(message, { cause });
  }
}

export const markTransportFailure = (cause: unknown, signal?: AbortSignal): unknown =>
  cause instanceof UpstreamTransportError || isCausedBy(cause, signal?.reason) ? cause : new UpstreamTransportError(cause);

const relayReadable = (source: ReadableStream<Uint8Array>, failed: (cause: unknown) => unknown): ReadableStream<Uint8Array> => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const current = reader ??= source.getReader();
      const pending = current.read();
      const item = await pending.catch((cause: unknown) => {
        if (cancelled) throw cause;
        current.releaseLock();
        throw failed(cause);
      });
      if (cancelled) return;
      if (item.done) {
        current.releaseLock();
        controller.close();
      } else {
        controller.enqueue(item.value);
      }
    },
    async cancel(reason) {
      cancelled = true;
      if (reader === undefined) {
        await source.cancel(reason);
        return;
      }
      try {
        await reader.cancel(reason);
      } finally {
        reader.releaseLock();
      }
    },
  }, { highWaterMark: 0 });
};

export const transportReadable = (
  source: ReadableStream<Uint8Array>, signal?: AbortSignal, isForwardedFailure?: (cause: unknown) => boolean,
): ReadableStream<Uint8Array> =>
  relayReadable(source, cause => isForwardedFailure?.(cause) === true ? cause : markTransportFailure(cause, signal));

export const trackReadableFailure = (source: ReadableStream<Uint8Array>) => {
  if (source.locked) throw new TypeError('The readable stream is locked');
  let failure: { cause: unknown } | undefined;
  const body = relayReadable(source, cause => {
    failure = { cause };
    return cause;
  });
  return { body, get failure() { return failure; } };
};

interface NativeFetchErrors {
  upload?: ReturnType<typeof trackReadableFailure> | undefined;
  isFetchTransportFailure: (cause: unknown) => boolean;
  isBodyTransportFailure?: (cause: unknown) => boolean;
}

export const fetchWithTransportErrors = async (
  request: Request | string,
  init: RequestInit | undefined,
  { upload, isFetchTransportFailure, isBodyTransportFailure }: NativeFetchErrors,
): Promise<ProviderFetchResult> => {
  const { protocol } = new URL(typeof request === 'string' ? request : request.url);
  if (protocol !== 'https:' && protocol !== 'http:') throw new TypeError(`Unsupported upstream fetch protocol: ${protocol}`);
  const signal = typeof request === 'string' ? init?.signal : request.signal;
  const pending = fetch(request, init);
  const response = await pending.catch((cause: unknown) => {
    const bodyFailure = upload?.failure;
    if (bodyFailure !== undefined && isCausedBy(cause, bodyFailure.cause)) throw bodyFailure.cause;
    if (isFetchTransportFailure(cause)) throw markTransportFailure(cause, signal ?? undefined);
    throw cause;
  });
  if (isBodyTransportFailure === undefined) return { response };
  return {
    response,
    identifyBodyTransportFailure(cause) {
      const bodyFailure = upload?.failure;
      if (bodyFailure !== undefined && isCausedBy(cause, bodyFailure.cause)) return undefined;
      return isBodyTransportFailure(cause) ? new UpstreamTransportError(cause) : undefined;
    },
  };
};
