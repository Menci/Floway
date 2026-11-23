import { type HeaderEntry, type HttpResponseBodyChunk, type HttpResponseFacts, isTransportFailure } from '@floway-dev/http';
import { Bytes, type ManagedStream } from '@floway-dev/pipeline';
import { viewOf } from '@floway-dev/pipeline/bytes-view';

export const httpHeaders = (entries: readonly HeaderEntry[]): Headers => {
  const headers = new Headers();
  for (const [name, value] of entries) headers.append(name, typeof value === 'string' ? value : value.reveal());
  return headers;
};

const readable = (body: ManagedStream<HttpResponseBodyChunk>): ReadableStream<Uint8Array> => {
  let iterator: AsyncIterator<HttpResponseBodyChunk> | undefined;
  return new ReadableStream({
    pull: async controller => {
      iterator ??= body[Symbol.asyncIterator]();
      const { done, value } = await iterator.next();
      if (done) controller.close();
      else if (isTransportFailure(value)) {
        controller.error(new Error(value.error.message));
        await body.close();
      } else controller.enqueue(value.toUint8Array());
    },
    cancel: () => body.close(),
  }, { highWaterMark: 0 });
};

export const writeHttpResponse = ({ status, statusText, headers, body }: HttpResponseFacts): Response =>
  new Response(body instanceof Bytes ? viewOf(body) as Uint8Array<ArrayBuffer> : body === null ? null : readable(body), {
    status,
    statusText,
    headers: httpHeaders(headers),
  });
