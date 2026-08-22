import { expect, test } from 'vitest';

import {
  parseStoredOpenAIResponsesPayload,
  prepareStoredOpenAIResponsesPayload,
  writePreparedStoredOpenAIResponsesPayload,
} from '../../src/repo/openai-responses-payload.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

const payload = (content: string) => ({
  item: { type: 'message', id: 'msg_payload', role: 'assistant', content },
  private: { search: ['one', 'two'] },
});

const largeContent = (): string => Array.from({ length: 4_096 }, () => crypto.randomUUID()).join('');

test('small OpenAI Responses payloads stay inline without a file relation', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload('small');
  const prepared = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);

  expect(prepared.file).toBeNull();
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, null)).resolves.toEqual(expected);
});

test('reads a fixed inline OpenAI Responses payload in the persisted format', async () => {
  initFileStore(new MemoryFileStore());
  const expected = {
    item: { type: 'message', id: 'msg_persisted', role: 'assistant', content: 'persisted' },
  };
  const descriptor = JSON.stringify({
    version: 1,
    storage: 'inline',
    encoding: 'gzip',
    payload: 'H4sIAAAAAAAAE0XKOwrAMAwE0btsrRPoMsHEizHEHyw1wfjuQVXKGd5GdTbohr+TUDSapUIIao60ck0uq+bMEKzxhEoWJ3WH4B7d2R2KH57zAX61IIJZAAAA',
  });
  await expect(parseStoredOpenAIResponsesPayload('msg_persisted', descriptor, null)).resolves.toEqual(expected);
});

test('large OpenAI Responses payloads use an external file whose key is not embedded in payload JSON', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const expected = payload(largeContent());
  const prepared = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  if (prepared.file === null) throw new Error('expected payload to spill');

  expect(prepared.payloadJson).not.toContain(prepared.file.key);
  await writePreparedStoredOpenAIResponsesPayload(prepared);
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key)).resolves.toEqual(expected);
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, null))
    .rejects.toThrow('file key missing');
});

test('each prepared spill uses a unique object key', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload(largeContent());
  const first = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  const second = await prepareStoredOpenAIResponsesPayload('msg_payload', 'key-a', expected);
  if (first.file === null || second.file === null) throw new Error('expected payloads to spill');

  expect(first.file.key).not.toBe(second.file.key);
});

test('spilled payload reads verify file integrity', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const prepared = await prepareStoredOpenAIResponsesPayload(
    'msg_payload',
    'key-a',
    payload(largeContent()),
  );
  if (prepared.file === null) throw new Error('expected payload to spill');

  await files.put(prepared.file.key, new Uint8Array([1, 2, 3]));
  await expect(parseStoredOpenAIResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key))
    .rejects.toThrow(/size mismatch|hash mismatch/u);
});
