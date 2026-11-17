import { test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { structuredResponsesFixture } from '../openai-responses/fixtures.ts';
import type { AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { openaiResponsesResultToEvents, type OpenAIResponsesResultEx, type OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const codec = createTestSidecarCodec();
const translate = (frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>) => buildSourceEventsFor(
  pairs.messagesToResponses[0], pairs.messagesToResponses[1], emptyPayload.messages, { sidecarCodec: codec }, frames,
);

const makeResponse = (status: OpenAIResponsesResultEx['status']): OpenAIResponsesResultEx => ({
  id: 'resp_123',
  object: 'response',
  model: 'gpt-test',
  status,
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

const toProtocolFrame = (event: OpenAIResponsesStreamEventEx): ProtocolFrame<OpenAIResponsesStreamEventEx> => eventFrame({ ...event, sequence_number: 0 });

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

test('translateToSourceEvents translates OpenAI Responses failed terminal to Anthropic Messages error', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'response.failed',
      response: {
        ...makeResponse('failed'),
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

  for await (const frame of translate(structuredResponsesFixture(stream()))) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream failed',
        provider_specific_fields: { code: 'server_error', type: 'server_error' },
      },
    } satisfies AnthropicMessagesStreamEventEx),
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

  for await (const frame of translate(structuredResponsesFixture(stream()))) {
    frames.push(frame);
  }

  assertEquals(frames, [
    eventFrame({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'upstream overloaded',
        provider_specific_fields: { code: 'overloaded_error' },
      },
    } satisfies AnthropicMessagesStreamEventEx),
  ]);
});
