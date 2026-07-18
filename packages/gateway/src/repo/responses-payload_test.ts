import { test } from 'vitest';

import { parseStoredResponsesPayload, serializeStoredResponsesPayload, sweepExpiredResponsesItemPayloadFiles } from './responses-payload.ts';
import { initFileProvider, MemoryFileProvider } from '@floway-dev/platform';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

// gzip flattens long runs of a single character almost to nothing, so spill
// tests need a body that resists compression. Random bytes hex-encoded into
// JSON-safe characters keep the post-gzip size close to the source size.
const incompressibleString = (approxBytes: number): string => {
  const bytes = new Uint8Array(Math.ceil(approxBytes / 2));
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex.slice(0, approxBytes);
};

test('the reserved private payload field round-trips through both inline and file storage', async () => {
  initFileProvider(new MemoryFileProvider());

  const inline = await serializeStoredResponsesPayload('msg_inline', 'key-test', 0, {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });
  assertEquals(await parseStoredResponsesPayload('msg_inline', inline), {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });

  // A payload past the inline limit spills its body to the file provider; the
  // private slot must survive that path too.
  const spilled = await serializeStoredResponsesPayload('msg_spilled', 'key-test', 0, {
    item: { type: 'message', id: 'msg_big', content: incompressibleString(96 * 1024) },
    private: { results: 'preserved' },
  });
  const parsed = await parseStoredResponsesPayload('msg_spilled', spilled);
  assertEquals(parsed.private, { results: 'preserved' });
});

test('identical spilled payload writes get distinct owned keys that retain the content hash', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const createdAt = Date.UTC(2026, 4, 28, 12);

  const content = incompressibleString(96 * 1024);
  const first = await serializeStoredResponsesPayload('msg_same_id', 'key_a', createdAt, {
    item: { type: 'message', id: 'msg_big', content },
  });
  const second = await serializeStoredResponsesPayload('msg_same_id', 'key_a', createdAt, {
    item: { type: 'message', id: 'msg_big', content },
  });
  const firstDescriptor = JSON.parse(first) as { key: string; sha256: string };
  const secondDescriptor = JSON.parse(second) as { key: string; sha256: string };

  assertEquals((await files.listKeys('responses-items/v1/expires/')).length, 2);
  assert(firstDescriptor.key !== secondDescriptor.key);
  assert(firstDescriptor.key.includes(firstDescriptor.sha256));
  assert(secondDescriptor.key.includes(secondDescriptor.sha256));
  assertEquals((await parseStoredResponsesPayload('msg_same_id', first)).item, { type: 'message', id: 'msg_big', content });
  assertEquals((await parseStoredResponsesPayload('msg_same_id', second)).item, { type: 'message', id: 'msg_big', content });
});

test('inline payload round-trips through gzip+base64 and the descriptor advertises the encoding', async () => {
  initFileProvider(new MemoryFileProvider());

  const serialized = await serializeStoredResponsesPayload('msg_round', 'key-test', 0, {
    item: { type: 'message', id: 'msg_round', content: 'hello world' },
  });
  const descriptor = JSON.parse(serialized) as Record<string, unknown>;
  assertEquals(descriptor.version, 1);
  assertEquals(descriptor.storage, 'inline');
  assertEquals(descriptor.encoding, 'gzip');
  assertEquals(typeof descriptor.payload, 'string');

  assertEquals(await parseStoredResponsesPayload('msg_round', serialized), {
    item: { type: 'message', id: 'msg_round', content: 'hello world' },
  });
});

test('spilled payload file body is gzip-compressed and the descriptor records the encoding', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);

  const original = incompressibleString(96 * 1024);
  const serialized = await serializeStoredResponsesPayload('msg_file_gz', 'key_a', 0, {
    item: { type: 'message', id: 'msg_file_gz', content: original },
  });
  const descriptor = JSON.parse(serialized) as Record<string, unknown>;
  assertEquals(descriptor.storage, 'file');
  assertEquals(descriptor.encoding, 'gzip');

  const fileBody = await files.get(descriptor.key as string);
  assert(fileBody !== null);
  // gzip RFC 1952 magic bytes — not the textual leading '{' a JSON body would
  // start with.
  assertEquals(fileBody[0], 0x1f);
  assertEquals(fileBody[1], 0x8b);

  assertEquals(await parseStoredResponsesPayload('msg_file_gz', serialized), {
    item: { type: 'message', id: 'msg_file_gz', content: original },
  });
});

test('a tampered file body fails its hash check', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);

  const serialized = await serializeStoredResponsesPayload('msg_tampered', 'key_a', 0, {
    item: { type: 'message', id: 'msg_tampered', content: incompressibleString(96 * 1024) },
  });
  const descriptor = JSON.parse(serialized) as { key: string; byteLength: number };
  // Replace the body with a different incompressible blob of the same length;
  // sha256 changes but byteLength matches, so the hash check is the only line
  // of defense.
  const tampered = new Uint8Array(descriptor.byteLength);
  crypto.getRandomValues(tampered);
  await files.put(descriptor.key, tampered);

  await assertRejects(() => parseStoredResponsesPayload('msg_tampered', serialized), Error, 'hash mismatch');
});

test('sweepExpiredResponsesItemPayloadFiles deletes every elapsed hour bucket and leaves the current and future buckets intact', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);

  // Two buckets older than the previous hour, the previous hour, the current
  // hour, and a future hour. A bucket is expired iff its hour is strictly
  // before the current hour, so only the first three should be deleted.
  await files.put('responses-items/v1/expires/2026/06/27/08/scope/a.json', new Uint8Array([1]));
  await files.put('responses-items/v1/expires/2026/06/27/09/scope/b.json', new Uint8Array([2]));
  await files.put('responses-items/v1/expires/2026/06/27/10/scope/c.json', new Uint8Array([3]));
  await files.put('responses-items/v1/expires/2026/06/27/11/scope/d.json', new Uint8Array([4]));
  await files.put('responses-items/v1/expires/2026/06/27/12/scope/e.json', new Uint8Array([5]));

  // now=2026-06-27T11:30 — the current hour is 11.
  await sweepExpiredResponsesItemPayloadFiles(Date.UTC(2026, 5, 27, 11, 30));

  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/08/scope/a.json'), null);
  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/09/scope/b.json'), null);
  assertEquals(await files.get('responses-items/v1/expires/2026/06/27/10/scope/c.json'), null);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/11/scope/d.json'))!], [4]);
  assertEquals([...(await files.get('responses-items/v1/expires/2026/06/27/12/scope/e.json'))!], [5]);
});
