import { isCloudflareNetworkFailure } from './network-failure.ts';
import { fetchWithTransportErrors, isReplayableBody, restoreRematerializedHttpAbort, toRequestInit, type Fetcher, type FetchInit, type FetchResponse } from '@floway-dev/http';

interface FixedLengthStreamConstructor {
  new(contentLength: number): {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<ArrayBuffer | ArrayBufferView>;
  };
}

declare const FixedLengthStream: FixedLengthStreamConstructor;

const network = {
  isFetchTransportFailure: isCloudflareNetworkFailure,
  classifyBodyFailure: (cause: unknown) => isCloudflareNetworkFailure(cause) ? { kind: 'transport' as const, cause } : undefined,
  restoreAbort: restoreRematerializedHttpAbort,
};

export const cloudflareFetch: Fetcher = async (url, init) => {
  const body = init.body;
  if (!isReplayableBody(body)) {
    if (!(body instanceof ReadableStream)) return await fetchWithTransportErrors(url, toRequestInit(init, body), network);
    return await fetchUpload(url, init, body);
  }
  if (!Number.isSafeInteger(body.contentLength) || body.contentLength < 0) {
    throw new RangeError('Replayable body content length must be a non-negative safe integer');
  }
  return await fetchUpload(url, init, body.open(), body.contentLength);
};

const fetchUpload = async (
  url: string,
  init: FetchInit,
  source: ReadableStream<unknown>,
  contentLength?: number,
): Promise<FetchResponse> => {
  if (source.locked) throw new TypeError('The upload stream is locked');
  const interrupted = new AbortController();
  const signal = init.signal == null ? interrupted.signal : AbortSignal.any([init.signal, interrupted.signal]);
  const failure = Promise.withResolvers<never>();
  let uploadFailure: { cause: unknown } | undefined;
  // Workerd pumps the request body separately from the response promise.
  // The upload can still fail after the peer starts its response. Terminate
  // both directions while the native exchange still depends on this source.
  const upload = observeUpload(source, contentLength, cause => {
    uploadFailure = { cause };
    failure.reject(cause);
    // Workerd treats a custom abort reason as a failure of its detached upload
    // pump. Use its native cancellation and keep the source failure here.
    interrupted.abort();
  });
  let body = upload;
  if (contentLength !== undefined) {
    // Workers uses FixedLengthStream to preserve fixed framing for streams.
    // https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header
    const fixed = new FixedLengthStream(contentLength);
    const transfer = upload.pipeTo(fixed.writable, { preventClose: true }).then(async () => {
      if (uploadFailure === undefined) await fixed.writable.close();
    });
    // A native early response can stop the transfer at its writable end.
    void transfer.catch(() => undefined);
    body = fixed.readable;
  }
  const fetchResponse = fetchWithTransportErrors(url, toRequestInit({ ...init, signal }, body), {
    ...network,
    restoreAbort(cause, nativeSignal) {
      if (uploadFailure !== undefined) {
        const reason: unknown = interrupted.signal.reason;
        // The selected signal proves which cancellation won; workerd can
        // reconstruct its native error with a fresh identity on either side.
        if (nativeSignal?.reason === reason && reason instanceof Error && cause instanceof Error
          && cause.name === reason.name && cause.message === reason.message) {
          throw uploadFailure.cause;
        }
      }
      return restoreRematerializedHttpAbort(cause, nativeSignal);
    },
  });
  return await Promise.race([fetchResponse, failure.promise]);
};

const observeUpload = (
  source: ReadableStream<unknown>,
  contentLength: number | undefined,
  fail: (cause: unknown) => void,
): ReadableStream<Uint8Array> => {
  let reader: ReadableStreamDefaultReader<unknown> | undefined;
  let bytes = 0;
  let stopped = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const current = reader ??= source.getReader();
      try {
        const item = await current.read();
        if (stopped) return;
        if (item.done) {
          if (contentLength !== undefined && bytes !== contentLength) {
            throw new RangeError('HTTP request body stream ended before its declared content length');
          }
          current.releaseLock();
          controller.close();
          return;
        }
        if (!(item.value instanceof Uint8Array)) throw new TypeError('HTTP request body stream yielded a non-Uint8Array chunk');
        bytes += item.value.byteLength;
        if (contentLength !== undefined && bytes > contentLength) {
          throw new RangeError('HTTP request body stream exceeded its declared content length');
        }
        controller.enqueue(item.value);
      } catch (cause) {
        if (stopped) return;
        stopped = true;
        fail(cause);
        controller.close();
        try {
          await current.cancel(cause);
        } catch { /* the source failure already settled the upload */ } finally {
          current.releaseLock();
        }
      }
    },
    async cancel(reason) {
      if (stopped) return;
      stopped = true;
      if (reader === undefined) {
        await source.cancel(reason);
        return;
      }
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
};
