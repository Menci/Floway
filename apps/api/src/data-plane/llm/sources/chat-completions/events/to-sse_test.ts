import { test } from 'vitest';

import { chatProtocolFrameToSSEFrame } from './to-sse.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';

const includeUsageChunk = { includeUsageChunk: true };

test('chatProtocolFrameToSSEFrame passes through non-chunk JSON payloads', () => {
  const payload = {
    error: { message: 'boom' },
  } as unknown as ChatCompletionChunk;

  const frame = chatProtocolFrameToSSEFrame(eventFrame(payload), includeUsageChunk);

  assertEquals(frame, {
    type: 'sse',
    event: undefined,
    data: JSON.stringify(payload),
  });
});

test('chatProtocolFrameToSSEFrame serializes DONE without owning termination', () => {
  const chunk = {
    id: 'chatcmpl_done',
    object: 'chat.completion.chunk',
    created: 123,
    model: 'gpt-test',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', content: 'hello' },
        finish_reason: null,
      },
    ],
  } satisfies ChatCompletionChunk;

  const frames = [
    eventFrame(chunk),
    doneFrame(),
    eventFrame({
      ...chunk,
      id: 'chatcmpl_after_done',
      choices: [
        {
          index: 0,
          delta: { content: 'ignored' },
          finish_reason: null,
        },
      ],
    }),
  ].map(frame => chatProtocolFrameToSSEFrame(frame, includeUsageChunk));

  assertEquals(
    frames.map(frame => frame?.data),
    [
      JSON.stringify(chunk),
      '[DONE]',
      JSON.stringify({
        ...chunk,
        id: 'chatcmpl_after_done',
        choices: [
          {
            index: 0,
            delta: { content: 'ignored' },
            finish_reason: null,
          },
        ],
      }),
    ],
  );
});
