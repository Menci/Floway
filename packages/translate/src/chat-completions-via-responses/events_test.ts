import { test } from 'vitest';

import { translateToSourceEvents } from './events.ts';
import { assertEquals, assertRejects } from '../test-assert.ts';
import type { ChatCompletionChunk } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesResult, type ResponsesStreamEvent, type ResponseStreamEvent } from '@floway-dev/protocols/responses';

// Inlined copy of apps/api's chatProtocolFrameToSSEFrame: kept here so this
// translate-package test does not deep-import into apps/api. The behavior
// under test is the translate output's terminal-frame discipline, not the
// SSE projection itself.
const isUsageOnlyChunk = (frame: ProtocolFrame<ChatCompletionChunk>): boolean =>
  frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined;

const chatProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionChunk>, options: { includeUsageChunk: boolean }): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && isUsageOnlyChunk(frame)) return null;
  return sseFrame(JSON.stringify(frame.event));
};

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

const includeUsageChunk = { includeUsageChunk: true };

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>) {
  for await (const frame of translateToSourceEvents(frames)) {
    const sse = chatProtocolFrameToSSEFrame(frame, includeUsageChunk);
    if (sse) yield sse;
  }
};

const countDoneSentinels = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<number> => {
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (const frame of chatSseFrames(stream())) {
    if (frame.data === '[DONE]') doneCount++;
  }

  return doneCount;
};

const countAssistantStartChunksAndDone = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<{ assistantStartCount: number; doneCount: number }> => {
  let assistantStartCount = 0;
  let doneCount = 0;

  async function* stream() {
    yield* frames;
  }

  for await (const frame of chatSseFrames(stream())) {
    if (frame.data === '[DONE]') {
      doneCount++;
      continue;
    }

    const parsed = JSON.parse(frame.data) as {
      choices?: Array<{ delta?: { role?: string } }>;
    };
    if (parsed.choices?.[0]?.delta?.role === 'assistant') assistantStartCount++;
  }

  return { assistantStartCount, doneCount };
};

const drain = async <T>(frames: AsyncIterable<T>): Promise<void> => {
  for await (const _frame of frames) {
    // Exhaust the stream so async translator errors surface to the caller.
  }
};

const collect = async <T>(frames: AsyncIterable<T>): Promise<T[]> => {
  const collected = [];
  for await (const frame of frames) collected.push(frame);
  return collected;
};

test('translateToSourceEvents emits exactly one [DONE] for structured responses stream', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.created',
      response: makeResponse('in_progress'),
    }),
    toProtocolFrame({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'hello',
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('translateToSourceEvents emits exactly one [DONE] for fallback completion stream', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.output_text.done',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      text: 'hello',
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('translateToSourceEvents avoids assistant-start duplication for created+completed fallback', async () => {
  const { assistantStartCount, doneCount } = await countAssistantStartChunksAndDone([
    toProtocolFrame({
      type: 'response.created',
      response: makeResponse('in_progress'),
    }),
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
  ]);

  assertEquals(assistantStartCount, 1);
  assertEquals(doneCount, 1);
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
    text.push(frame.event.choices[0]?.delta.content ?? '');
  }

  assertEquals(text.join(''), 'No.');
});

test('translateToSourceEvents preserves deferred reasoning and stream usage', async () => {
  async function* stream() {
    yield* [
      toProtocolFrame({
        type: 'response.created',
        response: {
          ...makeResponse('in_progress'),
          id: 'resp_deferred_reasoning',
          output_text: '',
          output: [],
        },
      }),
      toProtocolFrame({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_0', summary: [] },
      }),
      toProtocolFrame({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      }),
      toProtocolFrame({
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'reasoning',
          id: 'rs_0',
          summary: [{ type: 'summary_text', text: 'trace' }],
        },
      }),
      toProtocolFrame({
        type: 'response.completed',
        response: {
          ...makeResponse('completed'),
          id: 'resp_deferred_reasoning',
          output_text: 'answer',
          output: [],
          usage: {
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16,
            input_tokens_details: { cached_tokens: 3 },
          },
        },
      }),
    ];
  }

  const frames = await collect(translateToSourceEvents(stream()));
  const events = [];
  for (const frame of frames) {
    if (frame.type === 'event') events.push(frame.event);
  }

  assertEquals(
    events.slice(0, -1).map(event => event.choices[0]?.delta),
    [
      { role: 'assistant' },
      { reasoning_text: 'trace' },
      {
        reasoning_items: [
          {
            type: 'reasoning',
            id: 'rs_0',
            summary: [{ type: 'summary_text', text: 'trace' }],
          },
        ],
      },
      { content: 'answer' },
      {},
    ],
  );

  assertEquals(events.at(-1)?.choices, []);
  assertEquals(events.at(-1)?.usage, {
    prompt_tokens: 12,
    completion_tokens: 4,
    total_tokens: 16,
    prompt_tokens_details: { cached_tokens: 3 },
  });
  assertEquals(frames.at(-1)?.type, 'done');
});

test('translateToSourceEvents stops after Responses terminal completion', async () => {
  const doneCount = await countDoneSentinels([
    toProtocolFrame({
      type: 'response.completed',
      response: makeResponse('completed'),
    }),
    toProtocolFrame({
      type: 'error',
      message: 'ignored after terminal',
      code: 'ignored_error',
    }),
  ]);

  assertEquals(doneCount, 1);
});

test('translateToSourceEvents translates Responses error events to Chat errors', async () => {
  async function* stream() {
    yield toProtocolFrame({
      type: 'error',
      message: 'upstream overloaded',
      code: 'overloaded_error',
    });
  }

  const frames = await collect(translateToSourceEvents(stream()));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, 'event');
  if (frames[0].type !== 'event') throw new Error('expected event frame');
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: 'upstream overloaded',
    type: 'overloaded_error',
    code: 'overloaded_error',
  });
});

test('translateToSourceEvents translates Responses failed terminal events to Chat errors', async () => {
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
  }

  const frames = await collect(translateToSourceEvents(stream()));

  assertEquals(frames.length, 1);
  assertEquals(frames[0].type, 'event');
  if (frames[0].type !== 'event') throw new Error('expected event frame');
  assertEquals((frames[0].event as unknown as Record<string, unknown>).error, {
    message: 'upstream failed',
    type: 'server_error',
    code: 'server_error',
  });
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
