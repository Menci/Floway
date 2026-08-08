import { stringifyChunked } from '@discoveryjs/json-ext';
import { klona } from 'klona/json';

import type { ReplayableBody } from './options.ts';

const encodeChunks = function* (chunks: Iterable<string>): Generator<Uint8Array> {
  const encoder = new TextEncoder();
  for (const chunk of chunks) yield encoder.encode(chunk);
};

export function* jsonByteChunks(value: unknown): Generator<Uint8Array> {
  yield* encodeChunks(stringifyChunked(value));
}

// json-ext's stringifyInfo() counts integer digits without generating the
// serialized output, but it does not apply JSON's exponent formatting: it
// reports 24 bytes for {x: 1e21}, while stringifyChunked() and JSON.stringify()
// emit the 11-byte {"x":1e+21}. Framing must therefore measure the exact chunks.
// https://github.com/discoveryjs/json-ext/blob/457d4d9d4e55bb1e14fde192715114b80e20c4c9/src/stringify-info.js#L70-L118
const serializedLength = (value: object): number => {
  let length = 0;
  for (const chunk of jsonByteChunks(value)) {
    length += chunk.byteLength;
    if (!Number.isSafeInteger(length)) throw new RangeError('Serialized JSON body exceeds the supported content length');
  }
  return length;
};

export const jsonRequestBody = (value: object): ReplayableBody => {
  const snapshot = klona(value);
  return {
    contentLength: serializedLength(snapshot),
    open: () => {
      const bytes = jsonByteChunks(snapshot);
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
