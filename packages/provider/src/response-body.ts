import type { HttpResponseFacts } from '@floway-dev/http';
import { Bytes } from '@floway-dev/pipeline';

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

export const readHttpBody = async (body: HttpResponseFacts['body']): Promise<Bytes> => {
  if (body === null) return Bytes.empty;
  if (body instanceof Bytes) return body;
  const parts: Bytes[] = [];
  for await (const part of body) parts.push(part);
  return Bytes.concat(parts);
};
