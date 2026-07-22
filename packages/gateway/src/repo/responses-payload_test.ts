import { test } from 'vitest';

import { parseStoredResponsesPayload, prepareStoredResponsesPayload, writePreparedStoredResponsesPayload } from './responses-payload.ts';
import { TEST_RESPONSES_STATE_EPOCH } from '../test-helpers/responses-state.ts';
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

const serializePayload = async (
  id: string,
  apiKeyId: string,
  payload: Parameters<typeof prepareStoredResponsesPayload>[3],
): Promise<string> => {
  const prepared = await prepareStoredResponsesPayload(id, apiKeyId, TEST_RESPONSES_STATE_EPOCH, payload);
  await writePreparedStoredResponsesPayload(prepared);
  return prepared.payloadJson;
};

test('the reserved private payload field round-trips through both inline and file storage', async () => {
  initFileProvider(new MemoryFileProvider());

  const inline = await serializePayload('msg_inline', 'key-test', {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });
  assertEquals(await parseStoredResponsesPayload('msg_inline', inline), {
    item: { type: 'web_search_call', id: 'ws_x' },
    private: { results: [{ url: 'https://example.test', title: 'kept' }] },
  });

  // A payload past the inline limit spills its body to the file provider; the
  // private slot must survive that path too.
  const spilled = await serializePayload('msg_spilled', 'key-test', {
    item: { type: 'message', id: 'msg_big', content: incompressibleString(96 * 1024) },
    private: { results: 'preserved' },
  });
  const parsed = await parseStoredResponsesPayload('msg_spilled', spilled);
  assertEquals(parsed.private, { results: 'preserved' });
});

test('identical spilled payload writes get distinct owned keys that retain the content hash', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const content = incompressibleString(96 * 1024);
  const first = await serializePayload('msg_same_id', 'key_a', {
    item: { type: 'message', id: 'msg_big', content },
  });
  const second = await serializePayload('msg_same_id', 'key_a', {
    item: { type: 'message', id: 'msg_big', content },
  });
  const firstDescriptor = JSON.parse(first) as { key: string; sha256: string };
  const secondDescriptor = JSON.parse(second) as { key: string; sha256: string };

  assertEquals((await files.listKeys('responses-items/v2/objects/')).length, 2);
  assert(firstDescriptor.key !== secondDescriptor.key);
  assert(firstDescriptor.key.includes(firstDescriptor.sha256));
  assert(secondDescriptor.key.includes(secondDescriptor.sha256));
  assertEquals((await parseStoredResponsesPayload('msg_same_id', first)).item, { type: 'message', id: 'msg_big', content });
  assertEquals((await parseStoredResponsesPayload('msg_same_id', second)).item, { type: 'message', id: 'msg_big', content });
});

test.each([
  '../../outside',
  'provider/path/item',
  '项目/'.repeat(4_096),
])('spilled payload keys never embed arbitrary producer id %s', async id => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const content = incompressibleString(96 * 1024);
  const serialized = await serializePayload(id, 'key_a', {
    item: { type: 'message', id, content },
  });
  const descriptor = JSON.parse(serialized) as { key: string };

  assert(descriptor.key.startsWith('responses-items/v2/objects/'));
  assert(!descriptor.key.includes(id));
  assert(/^responses-items\/v2\/objects\/[0-9a-f]{64}\/[0-9a-f]{32}\/[0-9a-f]{64}\/[0-9a-f]{64}-[A-Za-z0-9_-]{22}\.gz$/.test(descriptor.key));
  assertEquals((await parseStoredResponsesPayload(id, serialized)).item, {
    type: 'message',
    id,
    content,
  });
});

test('inline payload round-trips through gzip+base64 and the descriptor advertises the encoding', async () => {
  initFileProvider(new MemoryFileProvider());

  const serialized = await serializePayload('msg_round', 'key-test', {
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
  const serialized = await serializePayload('msg_file_gz', 'key_a', {
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

  const serialized = await serializePayload('msg_tampered', 'key_a', {
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

test('preparing a spilled payload does not publish it before the caller stages the key', async () => {
  const files = new MemoryFileProvider();
  initFileProvider(files);
  const prepared = await prepareStoredResponsesPayload('msg_staged', 'key_a', TEST_RESPONSES_STATE_EPOCH, {
    item: { type: 'message', id: 'msg_staged', content: incompressibleString(96 * 1024) },
  });
  assert(prepared.file !== null);
  assertEquals(await files.get(prepared.file.key), null);

  await writePreparedStoredResponsesPayload(prepared);
  assert((await files.get(prepared.file.key)) !== null);
});
