import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEventData } from '@floway-dev/protocols/messages';
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent, type ResponseStreamEvent } from '@floway-dev/protocols/responses';

const makeResponse = (status: ResponsesResult['status']): ResponsesResult => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
  output_text: 'hello',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
    },
  ],
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toProtocolFrame = (event: ResponseStreamEvent): ProtocolFrame<ResponsesStreamEvent> => eventFrame({ ...event, sequence_number: 0 });

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents emits structured Messages events from the target-expanded sequence', async () => {
  // The target boundary (responsesStreamFramesToEvents) is responsible for
  // expanding upstream fast-path (created+completed only) into a full
  // structured event sequence via responsesResultToEvents. Translate now sees
  // only that expanded sequence and is a pure mapping.
  async function* stream() {
    for (const frame of responsesResultToEvents(makeResponse('completed'))) {
      yield frame;
    }
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'event', 'event', 'event', 'event', 'event'],
  );
  assertEquals(
    frames.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  );
});

test('translateToSourceEvents stops after Responses terminal', async () => {
  // Once the target-expanded sequence ends in response.completed, translate
  // must stop and ignore any extra upstream frames that arrive afterwards.
  async function* stream() {
    for (const frame of responsesResultToEvents(makeResponse('completed'))) {
      yield frame;
    }
    yield toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'ignored',
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(
    frames.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'],
  );
});

test('translateToSourceEvents preserves refusal text from JSON fallback', async () => {
  async function* stream() {
    yield* responsesResultToEvents({
      id: 'resp_refusal',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'No.' }],
        },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  }

  const text: string[] = [];

  for await (const frame of translateToSourceEvents(stream())) {
    if (frame.type !== 'event') continue;
    if (frame.event.type !== 'content_block_delta') continue;
    if (frame.event.delta.type !== 'text_delta') continue;

    text.push(frame.event.delta.text);
  }

  assertEquals(text.join(''), 'No.');
});

test('translateToSourceEvents translates Responses failed terminal to Messages error', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.failed',
      response: {
        ...makeResponse('failed'),
        output_text: '',
        output: [],
        error: {
          type: 'server_error',
          code: 'server_error',
          message: 'upstream failed',
        },
      },
    });
    yield toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream failed',
      },
    } satisfies MessagesStreamEventData),
  ]);
});

test('translateToSourceEvents translates Responses error terminal to Messages error', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'error',
      code: 'overloaded_error',
      message: 'upstream overloaded',
    });
    yield toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    });
  }

  const frames = [];

  for await (const frame of translateToSourceEvents(stream())) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream overloaded',
      },
    } satisfies MessagesStreamEventData),
  ]);
});

test('translateToSourceEvents rejects truncated Responses streams without terminal events', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream Responses stream ended without a terminal event.');
});
