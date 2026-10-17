import { Duplex } from 'node:stream';
import { createBrotliDecompress, createZstdDecompress } from 'node:zlib';

import type { HttpContentDecoders } from '@floway-dev/platform';

// https://nodejs.org/api/zlib.html#zlibcreatebrotlidecompressoptions
// https://nodejs.org/api/zlib.html#zlibcreatezstddecompressoptions
export const nodeHttpContentDecoders: HttpContentDecoders = new Map([
  ['br', () => Duplex.toWeb(createBrotliDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>],
  ['zstd', () => Duplex.toWeb(createZstdDecompress()) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>],
]);
