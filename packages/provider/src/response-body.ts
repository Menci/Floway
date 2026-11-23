import { isTransportFailure, type HttpResponseBodyChunk, type HttpResponseFacts, type TransportFailure } from '@floway-dev/http';
import { Bytes, type ErrorSnapshot } from '@floway-dev/pipeline';

// Cancelling an unread transport response releases its underlying connection.
export const discardUpstreamResponse = async (response: Response): Promise<void> => {
  await response.body?.cancel();
};

export type HttpOutput = { readonly 'response.http': HttpResponseFacts };

export const openByteStream = (source: AsyncIterable<Bytes>) => {
  const iterator = source[Symbol.asyncIterator]();
  let closed: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed ??= Promise.resolve(iterator.return?.()).then(() => undefined);
    return closed;
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value.toUint8Array());
    },
    cancel: close,
  }, { highWaterMark: 0 });
  return { stream, close };
};

export const checkedHttpBodyChunks = async function* (source: AsyncIterable<HttpResponseBodyChunk>): AsyncGenerator<HttpResponseBodyChunk> {
  let failure: TransportFailure | undefined;
  for await (const chunk of source) {
    if (failure !== undefined) throw new TypeError('An upstream HTTP body yielded a chunk after a transport failure');
    if (isTransportFailure(chunk)) failure = chunk;
    else yield chunk;
  }
  if (failure !== undefined) yield failure;
};

export type HttpBodyReadResult =
  | { readonly ok: true; readonly bytes: Bytes }
  | { readonly ok: false; readonly error: ErrorSnapshot };

export const readHttpBody = async (body: HttpResponseFacts['body']): Promise<HttpBodyReadResult> => {
  if (body === null) return { ok: true, bytes: Bytes.empty };
  if (body instanceof Bytes) return { ok: true, bytes: body };
  const parts: Bytes[] = [];
  for await (const part of checkedHttpBodyChunks(body)) {
    if (isTransportFailure(part)) return { ok: false, error: part.error };
    parts.push(part);
  }
  return { ok: true, bytes: Bytes.concat(parts) };
};
