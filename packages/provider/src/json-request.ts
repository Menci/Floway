import { stringifyChunked } from '@discoveryjs/json-ext';

import type { ReplayableBody } from './options.ts';

export function* jsonByteChunks(value: unknown): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of stringifyChunked(value)) yield encoder.encode(chunk);
}

const serializedLength = (value: object): number => {
  let length = 0;
  for (const chunk of jsonByteChunks(value)) {
    length += chunk.byteLength;
    if (!Number.isSafeInteger(length)) throw new RangeError('Serialized JSON body exceeds the supported content length');
  }
  return length;
};

export const jsonRequestBody = (value: object): ReplayableBody => {
  return {
    contentLength: serializedLength(value),
    open: () => {
      const chunks = jsonByteChunks(value);
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        },
        cancel() {
          chunks.return(undefined);
        },
      });
    },
  };
};
