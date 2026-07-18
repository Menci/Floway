import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, USAGE_BILLING, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiStreamEvent } from '@floway-dev/protocols/gemini';

const chunk = (
  delta: ChatCompletionsStreamEvent['choices'][0]['delta'],
  finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null,
  usage?: NonNullable<ChatCompletionsStreamEvent['usage']>,
): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index: 0, delta, finish_reason: finishReason }],
  ...(usage ? { usage } : {}),
});

const choiceChunk = (index: number, delta: ChatCompletionsStreamEvent['choices'][0]['delta'], finishReason: ChatCompletionsStreamEvent['choices'][0]['finish_reason'] = null): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  created: 1,
  model: 'gpt-test',
  choices: [{ index, delta, finish_reason: finishReason }],
});

const collect = async (input: ProtocolFrame<ChatCompletionsStreamEvent>[]): Promise<ProtocolFrame<GeminiStreamEvent>[]> => {
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

const drain = async (input: ProtocolFrame<ChatCompletionsStreamEvent>[]): Promise<void> => {
  await collect(input);
};

test('translateToSourceEvents maps text chunks and stop finish without emitting DONE', async () => {
  const frames = await collect([eventFrame(chunk({ role: 'assistant', content: 'Hello ' })), eventFrame(chunk({ content: 'world' }, 'stop')), doneFrame()]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'Hello ' }] },
        },
      ],
    }),
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'world' }] },
          finishReason: 'STOP',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents maps reasoning text and attaches opaque signature to next action', async () => {
  const frames = await collect([
    eventFrame(chunk({ role: 'assistant', reasoning_text: 'trace' })),
    eventFrame(chunk({ reasoning_opaque: 'sig_old' })),
    eventFrame(chunk({ reasoning_opaque: 'sig_1' })),
    eventFrame(chunk({ content: 'answer' })),
    eventFrame(chunk({}, 'stop')),
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
            parts: [{ text: 'answer', thoughtSignature: 'sig_1' }],
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

test('translateToSourceEvents flushes unclaimed opaque signature in the finish chunk', async () => {
  const frames = await collect([eventFrame(chunk({ role: 'assistant', reasoning_opaque: 'sig_only' })), eventFrame(chunk({}, 'stop')), doneFrame()]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: {
            role: 'model',
            parts: [{ text: '', thoughtSignature: 'sig_only' }],
          },
          finishReason: 'STOP',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents accumulates streamed tool calls and emits functionCall at finish', async () => {
  const frames = await collect([
    eventFrame(
      chunk({
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query"' },
          },
        ],
      }),
    ),
    eventFrame(
      chunk({
        tool_calls: [
          {
            index: 0,
            function: { arguments: ':"docs"}' },
          },
        ],
      }),
    ),
    eventFrame(chunk({}, 'tool_calls')),
    doneFrame(),
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
          finishReason: 'STOP',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents maps finish reasons and usage metadata', async () => {
  const usage = {
    prompt_tokens: 10,
    completion_tokens: 5,
    total_tokens: 15,
    completion_tokens_details: {
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
      reasoning_tokens: 2,
    },
  };

  const frames = await collect([eventFrame(chunk({}, 'length', usage)), doneFrame()]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 3,
        totalTokenCount: 15,
        thoughtsTokenCount: 2,
      },
    }),
  ]);

  const safetyFrames = await collect([eventFrame(chunk({}, 'content_filter')), doneFrame()]);

  assertEquals(
    safetyFrames[0],
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [] },
          finishReason: 'SAFETY',
        },
      ],
    }),
  );
});

test('translateToSourceEvents preserves multiple choices that finish in separate chunks', async () => {
  const frames = await collect([eventFrame(choiceChunk(0, { content: 'first' }, 'stop')), eventFrame(choiceChunk(1, { content: 'second' }, 'length')), doneFrame()]);

  assertEquals(frames, [
    geminiFrame({
      candidates: [
        {
          index: 0,
          content: { role: 'model', parts: [{ text: 'first' }] },
          finishReason: 'STOP',
        },
        {
          index: 1,
          content: { role: 'model', parts: [{ text: 'second' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
    }),
  ]);
});

test('translateToSourceEvents throws on upstream Chat error payloads', async () => {
  await assertRejects(
    async () =>
      await drain([
        eventFrame({
          error: { type: 'invalid_request_error', message: 'bad request' },
        } as unknown as ChatCompletionsStreamEvent),
        doneFrame(),
      ]),
    Error,
    'Upstream Chat Completions stream error: invalid_request_error: bad request',
  );
});

test('translateToSourceEvents preserves Chat cache and tier billing facts', async () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 8,
    total_tokens: 108,
    prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 25 },
    [USAGE_BILLING]: { cacheWrite1hTokenCount: 5 },
  };

  const frames = await collect([eventFrame({ ...chunk({}, 'stop', usage), service_tier: 'priority' }), doneFrame()]);

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
        [USAGE_BILLING]: { cacheWriteTokenCount: 20, cacheWrite1hTokenCount: 5, serviceTier: 'priority' },
      },
    }),
  ]);
});
