import { test } from 'vitest';

import { SETUP_SCRIPT_SOURCE_FRAGMENTS } from './script-assets.generated.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('generated installer sources match the checked-in canonical fragments byte for byte', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const [file, generated] of SETUP_SCRIPT_SOURCE_FRAGMENTS) {
    assertEquals(generated, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
  }
});
