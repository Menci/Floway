import { stringifyChunked } from '@discoveryjs/json-ext';

import type { ReplayableBody } from './options.ts';

const serializedLength = (value: object): number => {
  const encoder = new TextEncoder();
  let length = 0;
  for (const chunk of stringifyChunked(value)) {
    length += encoder.encode(chunk).byteLength;
    if (!Number.isSafeInteger(length)) throw new RangeError('Serialized JSON body exceeds the supported content length');
  }
  return length;
};

export const jsonRequestBody = (value: object): ReplayableBody => {
  return {
    contentLength: serializedLength(value),
    open: () => {
      const chunks = stringifyChunked(value);
      const encoder = new TextEncoder();
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.next();
          if (next.done) controller.close();
          else controller.enqueue(encoder.encode(next.value));
        },
        cancel() {
          chunks.return(undefined);
        },
      });
    },
  };
};
