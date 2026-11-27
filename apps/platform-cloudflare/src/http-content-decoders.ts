import { Duplex } from 'node:stream';
import { createBrotliDecompress, createZstdDecompress } from 'node:zlib';

import type { HttpContentDecoders } from '@floway-dev/platform';

const decoder = (stream: ReturnType<typeof createBrotliDecompress> | ReturnType<typeof createZstdDecompress>) => ({
  ...Duplex.toWeb(stream) as ReadableWritablePair<Uint8Array, Uint8Array>,
  isDataError: (cause: unknown) => cause instanceof Error && 'code' in cause
    && (cause.code === 'Z_BUF_ERROR' || cause.code === 'Z_DATA_ERROR' || cause.code === 'ERR_ZSTD_DECOMPRESSION_FAILED'),
});

// Workers exposes these codecs through node:zlib, not DecompressionStream.
// https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/
// https://github.com/cloudflare/workerd/blob/main/src/node/zlib.ts
export const cloudflareHttpContentDecoders: HttpContentDecoders = new Map([
  ['br', () => decoder(createBrotliDecompress())],
  ['zstd', () => decoder(createZstdDecompress())],
]);
