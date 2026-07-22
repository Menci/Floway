import { test } from 'vitest';

import { getFileProvider, initFileProvider, MemoryFileProvider } from './file-provider.ts';
import { assertEquals } from '@floway-dev/test-utils';

test('MemoryFileProvider clones at the provider boundary', async () => {
  const provider = new MemoryFileProvider();
  const body = new Uint8Array([1, 2, 3]);

  await provider.put('k', body);
  body[0] = 9;

  const first = await provider.get('k');
  assertEquals(first ? [...first] : null, [1, 2, 3]);
  first![1] = 8;

  assertEquals([...(await provider.get('k'))!], [1, 2, 3]);
});

test('runtime exposes one initialized FileProvider instance', async () => {
  const provider = new MemoryFileProvider();
  initFileProvider(provider);

  await getFileProvider().put('k', new Uint8Array([4]));
  assertEquals([...(await provider.get('k'))!], [4]);
});

test('MemoryFileProvider deletes every key that starts with the given prefix', async () => {
  const provider = new MemoryFileProvider();
  await provider.put('keep/a', new Uint8Array([1]));
  await provider.put('drop/a', new Uint8Array([2]));
  await provider.put('drop/b', new Uint8Array([3]));
  await provider.put('drops/c', new Uint8Array([4]));

  await provider.deletePrefix('drop/');

  assertEquals([...(await provider.get('keep/a'))!], [1]);
  assertEquals(await provider.get('drop/a'), null);
  assertEquals(await provider.get('drop/b'), null);
  assertEquals([...(await provider.get('drops/c'))!], [4]);
});

test('MemoryFileProvider deletes exact keys without treating them as prefixes', async () => {
  const provider = new MemoryFileProvider();
  await provider.put('drop/a', new Uint8Array([1]));
  await provider.put('drop/ab', new Uint8Array([2]));

  await provider.deleteKeys(['drop/a', 'missing']);

  assertEquals(await provider.get('drop/a'), null);
  assertEquals(await provider.get('drop/ab'), new Uint8Array([2]));
});

test('MemoryFileProvider bounds prefix deletion to one page', async () => {
  const provider = new MemoryFileProvider();
  for (let index = 0; index < 3; index += 1) await provider.put(`drop/${index}`, new Uint8Array([index]));

  assertEquals(await provider.deletePrefixPage('drop/', 2), { deleted: 2, complete: false });
  assertEquals(await provider.deletePrefixPage('drop/', 2), { deleted: 1, complete: true });
});

test('MemoryFileProvider lists every key that starts with the given prefix', async () => {
  const provider = new MemoryFileProvider();
  await provider.put('a/1', new Uint8Array([1]));
  await provider.put('a/2', new Uint8Array([2]));
  await provider.put('b/1', new Uint8Array([3]));

  assertEquals((await provider.listKeys('a/')).toSorted(), ['a/1', 'a/2']);
  assertEquals(await provider.listKeys('c/'), []);
});
