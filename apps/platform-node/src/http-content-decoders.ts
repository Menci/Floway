import { Duplex } from 'node:stream';
import { constants, createBrotliDecompress, createZstdDecompress } from 'node:zlib';

import type { HttpContentDecoders } from '@floway-dev/platform';

// Node's native zlib and zstd bindings expose decoding error codes.
// https://github.com/nodejs/node/blob/aa4c77582be995286fc6e00aaf530dc7ade102a9/src/node_zlib.cc
// An encoded dictionary identifier without a configured dictionary is a data error.
// https://github.com/nodejs/node/blob/60553651579ec33ca1aef9e1eedab2c3855f1f7e/src/node_zlib.cc#L1144-L1151
export const isNodeContentDataError = (cause: unknown): boolean => cause instanceof Error && 'code' in cause
  && (cause.code === 'Z_BUF_ERROR' || cause.code === 'Z_DATA_ERROR' || cause.code === 'ERR_ZSTD_DECOMPRESSION_FAILED'
    || (cause.code === 'Z_NEED_DICT' && 'errno' in cause && cause.errno === constants.Z_NEED_DICT));

const decoder = (stream: ReturnType<typeof createBrotliDecompress> | ReturnType<typeof createZstdDecompress>) => ({
  ...Duplex.toWeb(stream) as ReadableWritablePair<Uint8Array, Uint8Array>,
  isDataError: isNodeContentDataError,
});

// https://nodejs.org/api/zlib.html#zlibcreatebrotlidecompressoptions
// https://nodejs.org/api/zlib.html#zlibcreatezstddecompressoptions
export const nodeHttpContentDecoders: HttpContentDecoders = new Map([
  ['br', () => decoder(createBrotliDecompress())],
  ['zstd', () => decoder(createZstdDecompress())],
]);
