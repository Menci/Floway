import { expect, test } from 'vitest';

import type { MessagesStreamEvent } from '../../src/messages/index.ts';
import { reassembleMessagesEvents } from '../../src/messages/reassemble.ts';

const eventsFrom = async function* (events: readonly MessagesStreamEvent[]) {
  yield* events;
};

const messageStart = (usage: Record<string, unknown> = { input_tokens: 1, output_tokens: 0 }): MessagesStreamEvent => ({
  type: 'message_start',
  message: {
    id: 'msg_state',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage: usage as never,
  },
});

test('Messages reassembly preserves nested usage and initial thinking signatures', async () => {
  const result = await reassembleMessagesEvents(eventsFrom([
    messageStart({ input_tokens: 1, output_tokens: 0, output_tokens_details: { thinking_tokens: 7 } }),
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'thought', signature: 'sig_start' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_stop' },
  ]));

  expect(result.usage.output_tokens_details).toEqual({ thinking_tokens: 7 });
  expect(result.content).toEqual([{ type: 'thinking', thinking: 'thought', signature: 'sig_start' }]);
});

test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
  'Messages reassembly rejects invalid content block index %s',
  async index => {
    await expect(reassembleMessagesEvents(eventsFrom([
      messageStart(),
      { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
    ]))).rejects.toThrow('non-negative safe integer');
  },
);

test('Messages reassembly rejects gaps without allocating sparse content arrays', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 1_000_000, content_block: { type: 'text', text: 'bounded' } },
    { type: 'content_block_stop', index: 1_000_000 },
    { type: 'message_stop' },
  ]))).rejects.toThrow('missing index 0');
});

test('Messages reassembly rejects impossible block event orderings', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'early' } },
  ]))).rejects.toThrow('before its start event');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
  ]))).rejects.toThrow('cannot update a text block');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'message_stop' },
  ]))).rejects.toThrow('remained open');
});

test('Messages reassembly rejects semantically invalid tool input and citations', async () => {
  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tool', name: 'run', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'null' } },
    { type: 'content_block_stop', index: 0 },
  ]))).rejects.toThrow('must be a JSON object');

  await expect(reassembleMessagesEvents(eventsFrom([
    messageStart(),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [{ type: 'future' } as never] } },
  ]))).rejects.toThrow('Unsupported Messages text citation type');
});
