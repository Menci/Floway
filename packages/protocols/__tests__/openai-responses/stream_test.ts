import { test } from 'vitest';

import { type SseFrame } from '../../src/common/sse.ts';
import type { OpenAIResponsesResultEx } from '../../src/openai-responses/index.ts';
import { parseOpenAIResponsesStream } from '../../src/openai-responses/stream.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const parse = (...frames: SseFrame[]) => parseOpenAIResponsesStream(sseFrameBody(...frames));

const makeResponse = (status: OpenAIResponsesResultEx['status'], overrides: Partial<OpenAIResponsesResultEx> = {}): OpenAIResponsesResultEx => ({
  id: 'resp_fast',
  object: 'response',
  model: 'gpt-test',
  status,
  output: [
    {
      type: 'message',
      id: 'msg_fast',
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
  ...overrides,
});

test('parseOpenAIResponsesStream passes structured upstream events through unchanged when upstream already streams them', async () => {
  const frames = await collect(parse(
    sseFrame(
      JSON.stringify({
        response: { ...makeResponse('in_progress'), output: [] },
        sequence_number: 0,
      }),
      'response.created',
    ),
    sseFrame(
      JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', content: [] },
        sequence_number: 1,
      }),
    ),
    sseFrame(
      JSON.stringify({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'hello',
        sequence_number: 2,
      }),
    ),
    sseFrame(
      JSON.stringify({
        response: makeResponse('completed'),
        sequence_number: 3,
      }),
      'response.completed',
    ),
    sseFrame('[DONE]'),
  ));

  // All four event sequence numbers from upstream survive verbatim — no fast-path expansion.
  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [0, 1, 2, 3]);
});

test('parseOpenAIResponsesStream preserves error notifications and expands the following failed resource', async () => {
  const error = { type: 'error', code: null, param: 'model', message: 'Limit reached', sequence_number: 1, request_id: 'req_failed' };
  const failed = makeResponse('failed', { error: { code: 'rate_limit_exceeded', message: 'Limit reached' } });
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ type: 'response.created', response: { ...failed, status: 'in_progress', output: [], error: null }, sequence_number: 0 })),
    sseFrame(JSON.stringify(error), 'error'),
    sseFrame(JSON.stringify({ type: 'response.failed', response: failed, sequence_number: 2 })),
    sseFrame('[DONE]'),
  ));

  assertEquals(frames[1], { type: 'event', event: error });
  assertEquals(frames.map(frame => frame.type === 'event' ? frame.event.type : frame.type), [
    'response.created', 'error', 'response.in_progress', 'response.output_item.added',
    'response.content_part.added', 'response.output_text.delta', 'response.output_text.done',
    'response.content_part.done', 'response.output_item.done', 'response.failed', 'done',
  ]);
  const terminal = frames.at(-2);
  assertEquals(terminal?.type === 'event' && 'response' in terminal.event && terminal.event.response, failed);
});

test('parseOpenAIResponsesStream fast-paths when ping interleaves the wrappers', async () => {
  const completed = makeResponse('completed');
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({}), 'ping'),
    sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 1 }), 'response.in_progress'),
    sseFrame(JSON.stringify({}), 'ping'),
    sseFrame(JSON.stringify({ response: completed, sequence_number: 2 }), 'response.completed'),
    sseFrame('[DONE]'),
  ));

  const eventTypes: string[] = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.includes('response.output_item.added'), true);
  assertEquals(eventTypes.at(-1), 'response.completed');
  assertEquals(eventTypes.includes('ping'), false);
});
