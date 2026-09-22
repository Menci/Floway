import { test } from 'vitest';

import { translateToSourceEvents } from '../../src/anthropic-messages-via-openai-responses/events.ts';
import type { AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiResponsesResultToEvents, type OpenAIResponsesResult, type OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const makeResponse = (status: OpenAIResponsesResult['status']): OpenAIResponsesResult => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
  output_text: 'hello',
  output: [
    {
      type: 'message',
      id: 'msg_123',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello', annotations: [] }],
    },
  ],
  error: null,
  incomplete_details: null,
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    total_tokens: 5,
  },
});

const toProtocolFrame = (event: OpenAIResponsesStreamEvent): ProtocolFrame<OpenAIResponsesStreamEvent> => eventFrame({ ...event, sequence_number: 0 });

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents emits structured Anthropic Messages events from the target-expanded sequence', async () => {
  // The target boundary (openaiResponsesStreamFramesToEvents) is responsible for
  // expanding upstream fast-path (created+completed only) into a full
  // structured event sequence via openaiResponsesResultToEvents. Translate now sees
  // only that expanded sequence and is a pure mapping.
  async function* stream() {
    for (const frame of openaiResponsesResultToEvents(makeResponse('completed'))) {
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

test('translateToSourceEvents stops after OpenAI Responses terminal', async () => {
  // Once the target-expanded sequence ends in response.completed, translate
  // must stop and ignore any extra upstream frames that arrive afterwards.
  async function* stream() {
    for (const frame of openaiResponsesResultToEvents(makeResponse('completed'))) {
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

test('translateToSourceEvents preserves refusal semantics from JSON fallback', async () => {
  async function* stream() {
    yield* openaiResponsesResultToEvents({
      id: 'resp_refusal',
      object: 'response',
      model: 'gpt-test',
      status: 'completed',
      output_text: '',
      output: [
        {
          type: 'message',
          id: 'msg_refusal',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'refusal', refusal: 'No.' }],
        },
      ],
      error: null,
      incomplete_details: null,
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
  }

  let refusalDelta: Extract<AnthropicMessagesStreamEvent, { type: 'message_delta' }> | undefined;

  for await (const frame of translateToSourceEvents(stream())) {
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'message_delta') refusalDelta = frame.event;
  }

  assertEquals(refusalDelta?.delta, {
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: null, explanation: 'No.' },
    stop_sequence: null,
  });
});

test('translateToSourceEvents translates OpenAI Responses failed terminal to Anthropic Messages error', async () => {
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
    } satisfies AnthropicMessagesStreamEvent),
  ]);
});

test('translateToSourceEvents translates OpenAI Responses error terminal to Anthropic Messages error', async () => {
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
    } satisfies AnthropicMessagesStreamEvent),
  ]);
});

test('translateToSourceEvents rejects truncated OpenAI Responses streams without terminal events', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'partial',
    });
  }

  await assertRejects(async () => await drain(translateToSourceEvents(stream())), Error, 'Upstream OpenAI Responses stream ended without a terminal event.');
});
