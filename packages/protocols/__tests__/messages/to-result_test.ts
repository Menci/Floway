import { test } from 'vitest';

import { eventFrame } from '../../src/common/index.ts';
import type { MessagesResult, MessagesStreamEvent } from '../../src/messages/index.ts';
import { collectMessagesProtocolEventsToResult } from '../../src/messages/to-result.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('collectMessagesProtocolEventsToResult reassembles synthetic Messages events', async () => {
  const expected: MessagesResult = {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello' }],
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 3, output_tokens: 2 },
  };

  async function* events() {
    const payloads: MessagesStreamEvent[] = [
      {
        type: 'message_start',
        message: { ...expected, content: [], stop_reason: null, stop_sequence: null, usage: { ...expected.usage, output_tokens: 0 } },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ];
    for (const event of payloads) yield eventFrame(event);
  }

  assertEquals(await collectMessagesProtocolEventsToResult(events()), expected);
});

test('collectMessagesProtocolEventsToResult preserves final message_delta input_tokens', async () => {
  async function* events() {
    const payloads: MessagesStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_late_usage',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'answer' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { input_tokens: 12, output_tokens: 4 },
      },
      {
        type: 'message_stop',
      },
    ];

    for (const event of payloads) yield eventFrame(event);
  }

  const response = await collectMessagesProtocolEventsToResult(events());

  assertEquals(response.usage, { input_tokens: 12, output_tokens: 4 });
});

test('collectMessagesProtocolEventsToResult rejects streams without message_stop', async () => {
  async function* events() {
    const payloads: MessagesStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_truncated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 0 },
        },
      },
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'partial' },
      },
      {
        type: 'content_block_stop',
        index: 0,
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ];

    for (const event of payloads) yield eventFrame(event);
  }

  await assertRejects(async () => await collectMessagesProtocolEventsToResult(events()), Error, 'Messages stream ended without a message_stop event.');
});

test('collectMessagesProtocolEventsToResult rejects Messages error events', async () => {
  async function* events() {
    yield eventFrame({
      type: 'error',
      error: {
        type: 'overloaded_error',
        message: 'upstream overloaded',
      },
    } satisfies MessagesStreamEvent);
  }

  await assertRejects(async () => await collectMessagesProtocolEventsToResult(events()), Error, 'Upstream SSE error: overloaded_error: upstream overloaded');
});
