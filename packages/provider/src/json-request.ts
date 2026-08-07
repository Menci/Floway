import { stringifyChunked } from '@discoveryjs/json-ext';

import type { ReplayableBody } from './options.ts';

const encodeChunks = function* (chunks: Iterable<string>): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
};

const serializedLength = (chunks: readonly string[]): number => {
  let length = 0;
  for (const chunk of encodeChunks(chunks)) {
    length += chunk.byteLength;
    if (!Number.isSafeInteger(length)) throw new RangeError('Serialized JSON body exceeds the supported content length');
  }
  return length;
};

export const jsonRequestBody = (value: object): ReplayableBody => {
  const chunks = [...stringifyChunked(value)];
  return {
    contentLength: serializedLength(chunks),
    open: () => {
      const bytes = encodeChunks(chunks);
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = bytes.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          bytes.return(undefined);
        },
      });
    },
  };
};
