import { test } from 'vitest';

import { prepareImageEditSources } from './edit-source.ts';
import { initImageProcessor } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

test('prepareImageEditSources canonicalizes MIME aliases without copying bytes', async () => {
  const bytes = Uint8Array.of(1, 2, 3).buffer;
  const [prepared] = await prepareImageEditSources([{ bytes, mimeType: 'image/jpg' }]);
  assert(prepared !== undefined);
  assert(prepared.bytes === bytes);
  assertEquals(prepared.mimeType, 'image/jpeg');
});

test('prepareImageEditSources deduplicates transcoding for unsupported raster formats', async () => {
  let observedTarget: unknown = undefined;
  let processorCalls = 0;
  initImageProcessor({
    compressToWebp: (_input, target) => {
      processorCalls += 1;
      observedTarget = target;
      return Promise.resolve(Uint8Array.of(1, 2, 3));
    },
  });
  const first = {
    bytes: Uint8Array.of(4, 5, 6).buffer,
    mimeType: 'image/gif',
  };
  const sameBytes = { bytes: Uint8Array.of(4, 5, 6).buffer, mimeType: 'image/gif' };
  const prepared = await prepareImageEditSources([first, first, sameBytes]);
  assertEquals(processorCalls, 1);
  assert(prepared[0] === prepared[1]);
  assert(prepared[0] === prepared[2]);
  assertEquals(prepared[0].mimeType, 'image/webp');
  assertEquals([...new Uint8Array(prepared[0].bytes)], [1, 2, 3]);
  assertEquals(observedTarget, null);
});
