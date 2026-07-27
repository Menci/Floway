import { expect, test } from 'vitest';

import {
  parseStoredResponsesPayload,
  prepareStoredResponsesPayload,
  writePreparedStoredResponsesPayload,
} from '../../src/repo/responses-payload.ts';
import { initFileStore, MemoryFileStore } from '@floway-dev/platform';

const payload = (content: string) => ({
  item: { type: 'message', id: 'msg_payload', role: 'assistant', content },
  private: { search: ['one', 'two'] },
});

const largeContent = (): string => Array.from({ length: 4_096 }, () => crypto.randomUUID()).join('');

test('small Responses payloads stay inline without a file relation', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload('small');
  const prepared = await prepareStoredResponsesPayload('msg_payload', 'key-a', expected);

  expect(prepared.file).toBeNull();
  await expect(parseStoredResponsesPayload('msg_payload', prepared.payloadJson, null)).resolves.toEqual(expected);
});

test('large Responses payloads use an external file whose key is not embedded in payload JSON', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const expected = payload(largeContent());
  const prepared = await prepareStoredResponsesPayload('msg_payload', 'key-a', expected);
  if (prepared.file === null) throw new Error('expected payload to spill');

  expect(prepared.payloadJson).not.toContain(prepared.file.key);
  await writePreparedStoredResponsesPayload(prepared);
  await expect(parseStoredResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key)).resolves.toEqual(expected);
  await expect(parseStoredResponsesPayload('msg_payload', prepared.payloadJson, null))
    .rejects.toThrow('file key missing');
});

test('each prepared spill uses a unique object key', async () => {
  initFileStore(new MemoryFileStore());
  const expected = payload(largeContent());
  const first = await prepareStoredResponsesPayload('msg_payload', 'key-a', expected);
  const second = await prepareStoredResponsesPayload('msg_payload', 'key-a', expected);
  if (first.file === null || second.file === null) throw new Error('expected payloads to spill');

  expect(first.file.key).not.toBe(second.file.key);
});

test('spilled payload reads verify file integrity', async () => {
  const files = new MemoryFileStore();
  initFileStore(files);
  const prepared = await prepareStoredResponsesPayload(
    'msg_payload',
    'key-a',
    payload(largeContent()),
  );
  if (prepared.file === null) throw new Error('expected payload to spill');

  await files.put(prepared.file.key, new Uint8Array([1, 2, 3]));
  await expect(parseStoredResponsesPayload('msg_payload', prepared.payloadJson, prepared.file.key))
    .rejects.toThrow(/size mismatch|hash mismatch/u);
});
