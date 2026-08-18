import { test } from 'vitest';

import { translateToSourceEvents } from '../../src/gemini-generate-content-via-anthropic-messages/events.ts';
import type { AnthropicMessagesResult, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentStreamEvent } from '@floway-dev/protocols/gemini-generate-content';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const messageStart = (usage: AnthropicMessagesResult['usage'] = { input_tokens: 0, output_tokens: 0 }): AnthropicMessagesStreamEvent => ({
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    content: [],
    model: 'claude-test',
    stop_reason: null,
    stop_sequence: null,
    usage,
  },
});

const collect = async (input: ProtocolFrame<AnthropicMessagesStreamEvent>[]): Promise<ProtocolFrame<GeminiGenerateContentStreamEvent>[]> => {
  const output: ProtocolFrame<GeminiGenerateContentStreamEvent>[] = [];

  async function* frames() {
    yield* input;
  }

  for await (const frame of translateToSourceEvents(frames())) {
    output.push(frame);
  }

  return output;
};

const geminiGenerateContentFrame = (event: GeminiGenerateContentStreamEvent): ProtocolFrame<GeminiGenerateContentStreamEvent> => eventFrame(event);

const drain = async (input: ProtocolFrame<AnthropicMessagesStreamEvent>[]): Promise<void> => {
  await collect(input);
};

test('translateToSourceEvents maps text chunks, finish reason, and usage without DONE', async () => {
  const frames = await collect([
    eventFrame(messageStart({ input_tokens: 10, output_tokens: 0 })),
    eventFrame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Hello ' },
    }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'world' },
    }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 5 },
    }),
    eventFrame({ type: 'message_stop' }),
    doneFrame(),
  ]);

  assertEquals(frames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'Hello ' }] },
        },
      ],
    }),
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'world' }] },
        },
      ],
    }),
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
      },
    }),
  ]);
});

test('translateToSourceEvents maps thinking text and attaches signature to the next text action', async () => {
  const frames = await collect([
    eventFrame(messageStart()),
    eventFrame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'trace' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_old' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_1' },
    }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'text', text: '' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'answer' },
    }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    eventFrame({ type: 'message_stop' }),
  ]);

  assertEquals(frames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'trace', thought: true }] },
        },
      ],
    }),
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'answer', thoughtSignature: 'sig_1' }],
          },
        },
      ],
    }),
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents accumulates tool call JSON and attaches pending signature', async () => {
  const frames = await collect([
    eventFrame(messageStart()),
    eventFrame({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking', thinking: '' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_tool' },
    }),
    eventFrame({ type: 'content_block_stop', index: 0 }),
    eventFrame({
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'tool_use',
        id: 'tu_1',
        name: 'lookup',
        input: {},
      },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: '{"query"' },
    }),
    eventFrame({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'input_json_delta', partial_json: ':"docs"}' },
    }),
    eventFrame({ type: 'content_block_stop', index: 1 }),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
    eventFrame({ type: 'message_stop' }),
  ]);

  assertEquals(frames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'tu_1',
                  name: 'lookup',
                  args: { query: 'docs' },
                },
                thoughtSignature: 'sig_tool',
              },
            ],
          },
        },
      ],
    }),
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents maps max token and refusal finish reasons', async () => {
  const maxTokenFrames = await collect([
    eventFrame(messageStart({ input_tokens: 8, output_tokens: 0 })),
    eventFrame({
      type: 'message_delta',
      delta: { stop_reason: 'max_tokens' },
      usage: { output_tokens: 3 },
    }),
    eventFrame({ type: 'message_stop' }),
  ]);

  assertEquals(maxTokenFrames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: {
        promptTokenCount: 8,
        candidatesTokenCount: 3,
        totalTokenCount: 11,
      },
    }),
  ]);

  const refusalFrames = await collect([eventFrame(messageStart()), eventFrame({
    type: 'message_delta',
    delta: {
      stop_reason: 'refusal',
      stop_details: {
        type: 'refusal',
        category: 'bio',
        explanation: 'This request could enable biological harm.',
      },
    },
  }), eventFrame({ type: 'message_stop' })]);

  assertEquals(refusalFrames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'SAFETY',
          finishMessage: 'This request could enable biological harm.',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents throws on Anthropic Messages error events', async () => {
  await assertRejects(
    async () =>
      await drain([
        eventFrame({
          type: 'error',
          error: { type: 'invalid_request_error', message: 'bad request' },
        }),
      ]),
    Error,
    'Upstream Anthropic Messages stream error: invalid_request_error: bad request',
  );
});

test('translateToSourceEvents folds Anthropic cache fields into Gemini promptTokenCount and cachedContentTokenCount', async () => {
  const frames = await collect([
    eventFrame(
      messageStart({
        input_tokens: 10,
        output_tokens: 0,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
        cache_creation: { ephemeral_1h_input_tokens: 3 },
        speed: 'fast',
      }),
    ),
    eventFrame({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 7, service_tier: 'priority' },
    }),
    eventFrame({ type: 'message_stop' }),
  ]);

  assertEquals(frames, [
    geminiGenerateContentFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 45,
        candidatesTokenCount: 7,
        totalTokenCount: 52,
        cachedContentTokenCount: 30,
      },
    }),
  ]);
});

test('translateToSourceEvents accepts late input accounting from message_delta', async () => {
  const frames = await collect([
    eventFrame(messageStart()),
    eventFrame({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 5,
      },
    }),
    eventFrame({ type: 'message_stop' }),
  ]);
  const usage = frames[0]?.type === 'event' && !('error' in frames[0].event) ? frames[0].event.usageMetadata : undefined;
  assertEquals(usage?.promptTokenCount, 45);
  assertEquals(usage?.cachedContentTokenCount, 30);
});

test('translateToSourceEvents emits known input usage when terminal usage is absent', async () => {
  const frames = await collect([
    eventFrame(messageStart({ input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 2 })),
    eventFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
    eventFrame({ type: 'message_stop' }),
  ]);
  const usage = frames[0]?.type === 'event' && !('error' in frames[0].event) ? frames[0].event.usageMetadata : undefined;
  assertEquals(usage, {
    promptTokenCount: 12,
    candidatesTokenCount: 0,
    totalTokenCount: 12,
    cachedContentTokenCount: 2,
  });
});
