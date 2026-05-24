import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ResponsesResult, ResponseStreamEvent } from '@floway-dev/protocols/responses';

const response = (status: ResponsesResult['status'], extra: Partial<ResponsesResult> = {}): ResponsesResult => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-test',
  output: [],
  output_text: '',
  status,
  ...extra,
});

const collect = async (input: ProtocolFrame<ResponseStreamEvent>[]): Promise<ProtocolFrame<GeminiStreamEvent>[]> => {
  const output: ProtocolFrame<GeminiStreamEvent>[] = [];

  async function* frames() {
    yield* input;
  }

  for await (const frame of translateToSourceEvents(frames())) {
    output.push(frame);
  }

  return output;
};

const geminiFrame = (event: GeminiStreamEvent): ProtocolFrame<GeminiStreamEvent> => eventFrame(event);

const drain = async (input: ProtocolFrame<ResponseStreamEvent>[]): Promise<void> => {
  await collect(input);
};

test('translateToSourceEvents maps readable reasoning text without opaque Responses state', async () => {
  const frames = await collect([
    eventFrame({
      type: 'response.reasoning_summary_text.delta',
      item_id: 'rs_1',
      output_index: 0,
      summary_index: 0,
      delta: 'trace',
    }),
    eventFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    }),
    eventFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 1,
      content_index: 0,
      delta: 'answer',
    }),
    eventFrame({
      type: 'response.completed',
      response: response('completed', {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      }),
    }),
    doneFrame(),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'trace', thought: true }] },
        },
      ],
    }),
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: 'answer' }],
          },
        },
      ],
    }),
    geminiFrame({
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
        thoughtsTokenCount: 2,
      },
    }),
  ]);
});

test('translateToSourceEvents drops reasoning without readable summary at completion', async () => {
  const frames = await collect([
    eventFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    }),
    eventFrame({ type: 'response.completed', response: response('completed') }),
  ]);

  assertEquals(frames, [
    geminiFrame({
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

test('translateToSourceEvents accumulates function call arguments after empty reasoning', async () => {
  const frames = await collect([
    eventFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
      },
    }),
    eventFrame({
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '',
        status: 'in_progress',
      },
    }),
    eventFrame({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 1,
      delta: '{"query"',
    }),
    eventFrame({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      output_index: 1,
      arguments: '{"query":"docs"}',
    }),
    eventFrame({
      type: 'response.output_item.done',
      output_index: 1,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '',
        status: 'completed',
      },
    }),
    eventFrame({ type: 'response.completed', response: response('completed') }),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'lookup',
                  args: { query: 'docs' },
                },
              },
            ],
          },
        },
      ],
    }),
    geminiFrame({
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

test('translateToSourceEvents uses final function call arguments when streamed draft arguments are empty', async () => {
  const frames = await collect([
    eventFrame({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '',
        status: 'in_progress',
      },
    }),
    eventFrame({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'function_call',
        call_id: 'call_1',
        name: 'lookup',
        arguments: '{"query":"docs"}',
        status: 'completed',
      },
    }),
    eventFrame({ type: 'response.completed', response: response('completed') }),
  ]);

  assertEquals(frames[0], geminiFrame({
    candidates: [
      {
        index: 0,
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'lookup',
                args: { query: 'docs' },
              },
            },
          ],
        },
      },
    ],
  }));
});

test('translateToSourceEvents maps incomplete and failed finish reasons with usage', async () => {
  const maxTokenFrames = await collect([
    eventFrame({
      type: 'response.incomplete',
      response: response('incomplete', {
        incomplete_details: { reason: 'max_output_tokens' },
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      }),
    }),
  ]);

  assertEquals(maxTokenFrames, [
    geminiFrame({
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

  const safetyFrames = await collect([
    eventFrame({
      type: 'response.failed',
      response: response('failed', {
        error: {
          message: 'Blocked by safety policy.',
          type: 'safety',
          code: 'content_filter',
        },
      }),
    }),
  ]);

  assertEquals(safetyFrames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'SAFETY',
        },
      ],
    }),
  ]);

  const genericFrames = await collect([
    eventFrame({
      type: 'response.failed',
      response: response('failed', {
        error: {
          message: 'upstream unavailable',
          type: 'server_error',
          code: 'server_error',
        },
      }),
    }),
  ]);

  assertEquals(genericFrames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'OTHER',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents throws on Responses error stream events', async () => {
  await assertRejects(
    async () =>
      await drain([
        eventFrame({
          type: 'error',
          message: 'bad request',
          code: 'invalid_request_error',
        }),
      ]),
    Error,
    'Upstream Responses stream error: bad request',
  );
});

test('translateToSourceEvents surfaces input cached_tokens as cachedContentTokenCount', async () => {
  const frames = await collect([
    eventFrame({
      type: 'response.completed',
      response: response('completed', {
        usage: {
          input_tokens: 100,
          output_tokens: 8,
          total_tokens: 108,
          input_tokens_details: { cached_tokens: 30 },
        },
      }),
    }),
  ]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 8,
        totalTokenCount: 108,
        cachedContentTokenCount: 30,
      },
    }),
  ]);
});
