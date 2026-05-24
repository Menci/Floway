import { test } from 'vitest';

import { createMessagesStreamUsageState, tokenUsageFromMessagesFrame } from './respond.ts';
import { assertEquals } from '../../../../test-assert.ts';
import { eventFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';

const stop = () => eventFrame({ type: 'message_stop' } satisfies MessagesStreamEventData);

test('Messages stream usage keeps start input and delta output', () => {
  const state = createMessagesStreamUsageState();

  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 3,
          },
        },
      } satisfies MessagesStreamEventData),
      state,
    ),
    null,
  );
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 7 },
      } satisfies MessagesStreamEventData),
      state,
    ),
    null,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    inputTokens: 19,
    outputTokens: 7,
    cacheReadTokens: 3,
    cacheCreationTokens: 4,
  });
});

test('Messages stream usage can recover input from delta', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } satisfies MessagesStreamEventData),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5,
      },
    } satisfies MessagesStreamEventData),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { output_tokens: 6 },
    } satisfies MessagesStreamEventData),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    inputTokens: 23,
    outputTokens: 6,
    cacheReadTokens: 5,
    cacheCreationTokens: 7,
  });
});
