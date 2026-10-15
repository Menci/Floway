import { Duplex } from 'node:stream';
import { createBrotliDecompress, createZstdDecompress } from 'node:zlib';

import type { HttpContentDecoders } from '@floway-dev/platform';

// Workers exposes these codecs through node:zlib, not DecompressionStream.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/
// https://github.com/cloudflare/workerd/blob/main/src/node/zlib.ts
export const cloudflareHttpContentDecoders: HttpContentDecoders = new Map([
  ['br', () => Duplex.toWeb(createBrotliDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>],
  ['zstd', () => Duplex.toWeb(createZstdDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>],
]);
