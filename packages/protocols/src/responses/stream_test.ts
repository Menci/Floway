import { test } from 'vitest';

import type { ResponsesResult } from './index.ts';
import { parseResponsesStream } from './stream.ts';
import { type SseFrame } from '../common/sse.ts';
import { sseFrame, sseFrameBody } from '../common/test-utils.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const parse = (...frames: SseFrame[]) => parseResponsesStream(sseFrameBody(...frames));

const makeResponse = (status: ResponsesResult['status'], overrides: Partial<ResponsesResult> = {}): ResponsesResult => ({
  id: 'resp_fast',
  object: 'response',
  model: 'gpt-test',
  status,
  output_text: 'hello',
  output: [
    {
      type: 'message',
      id: 'msg_fast',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'hello' }],
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

test('parseResponsesStream parses Responses SSE frames into protocol events', async () => {
  const frames = await collect(parse(
    sseFrame(
      JSON.stringify({
        response: {
          id: 'resp_1',
          object: 'response',
          model: 'gpt-test',
          output: [],
          output_text: '',
          status: 'in_progress',
        },
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
    sseFrame('[DONE]'),
  ));

  assertEquals(
    frames.map(frame => frame.type),
    ['event', 'event', 'done'],
  );
  assertEquals(frames[0], {
    type: 'event',
    event: {
      type: 'response.created',
      response: {
        id: 'resp_1',
        object: 'response',
        model: 'gpt-test',
        output: [],
        output_text: '',
        status: 'in_progress',
      },
      sequence_number: 0,
    },
  });
});

test('parseResponsesStream rejects malformed Responses SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(parse(
        sseFrame('not json', 'response.output_text.delta'),
      ));
    },
    Error,
    'Malformed upstream Responses SSE JSON for event "response.output_text.delta": not json',
  );
});

test('parseResponsesStream expands upstream fast-path (created+in_progress+completed) into the full structured sequence', async () => {
  const response = makeResponse('completed');
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({ response, sequence_number: 1 }), 'response.in_progress'),
    sseFrame(JSON.stringify({ response, sequence_number: 2 }), 'response.completed'),
    sseFrame('[DONE]'),
  ));

  // The terminal must arrive only at the end, with no intermediate `response.completed`,
  // so downstream consumers see a single canonical full sequence.
  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assertEquals(frames.at(-1)?.type, 'done');
});

test('parseResponsesStream passes queued/created/in-progress wrappers through before fast-path expansion', async () => {
  const response = makeResponse('completed');
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: { ...response, status: 'queued' }, sequence_number: 0 }), 'response.queued'),
    sseFrame(JSON.stringify({ response: { ...response, status: 'in_progress' }, sequence_number: 1 }), 'response.created'),
    sseFrame(JSON.stringify({ response: { ...response, status: 'in_progress' }, sequence_number: 2 }), 'response.in_progress'),
    sseFrame(JSON.stringify({ response, sequence_number: 3 }), 'response.completed'),
    sseFrame('[DONE]'),
  ));

  // Wrappers are emitted before fast-path expansion (they are not buffered):
  // the terminal `response.completed` triggers expansion of the missing
  // structured events, then the terminal itself, then `done`.
  assertEquals(
    frames.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    [
      'response.queued',
      'response.created',
      'response.in_progress',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      'done',
    ],
  );
  assertEquals((frames[0] as { event: { sequence_number: number } }).event.sequence_number, 0);
  assertEquals((frames[2] as { event: { sequence_number: number } }).event.sequence_number, 2);
});

test('parseResponsesStream passes structured upstream events through unchanged when upstream already streams them', async () => {
  const frames = await collect(parse(
    sseFrame(
      JSON.stringify({
        response: { ...makeResponse('in_progress'), output: [], output_text: '' },
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

test('parseResponsesStream does not duplicate wrappers when fast-path expansion kicks in', async () => {
  // Wrappers have already been forwarded downstream, so fast-path expansion
  // synthesizes only the remaining content and terminal events.
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: makeResponse('in_progress'), sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({ response: makeResponse('in_progress'), sequence_number: 1 }), 'response.in_progress'),
    sseFrame(JSON.stringify({ response: makeResponse('completed'), sequence_number: 2 }), 'response.completed'),
    sseFrame('[DONE]'),
  ));

  // The upstream wrapper sequence numbers are kept and the synthesized content
  // continues from the canonical responseResultToEvents ordering.
  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('parseResponsesStream fills in sequence_number when upstream omits it (monotonic counter)', async () => {
  // Some upstreams (probes, fast-path completions) ship structured events
  // without `sequence_number`. The parser must assign one so downstream
  // consumers can rely on the field being present and increasing.
  const frames = await collect(parse(
    sseFrame(
      JSON.stringify({
        response: { ...makeResponse('in_progress'), output: [], output_text: '' },
      }),
      'response.created',
    ),
    sseFrame(
      JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', content: [] },
      }),
    ),
    sseFrame(
      JSON.stringify({
        type: 'response.output_text.delta',
        item_id: 'msg_1',
        output_index: 0,
        content_index: 0,
        delta: 'hello',
      }),
    ),
    sseFrame('[DONE]'),
  ));

  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [0, 1, 2]);
});

test('parseResponsesStream advances its counter past upstream-provided sequence numbers (no collisions)', async () => {
  // Upstream sets sequence_number=5 mid-stream; subsequent omitted ones must
  // continue from 6, not collide with the upstream's prior numbering.
  const frames = await collect(parse(
    sseFrame(
      JSON.stringify({
        response: { ...makeResponse('in_progress'), output: [], output_text: '' },
        sequence_number: 5,
      }),
      'response.created',
    ),
    sseFrame(
      JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', role: 'assistant', content: [] },
      }),
    ),
    sseFrame('[DONE]'),
  ));

  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [5, 6]);
});

test('parseResponsesStream fast-paths response.failed terminal with error preserved on terminal only', async () => {
  const failed = makeResponse('failed', {
    output: [],
    output_text: '',
    error: { type: 'server_error', code: 'server_error', message: 'upstream failed' },
  });
  // The in-progress wrapper must carry `error: null` per spec
  // (Response.error is required-nullable); upstreams that omit
  // the field are normalized by `responsesStartSnapshot`, which
  // is also what the fast-path expansion uses. Pre-populate the
  // null here so the assertion below reflects a single wire
  // contract across raw and synthesized frames.
  const { error: _error, ...rest } = failed;
  const created = { ...rest, status: 'in_progress' as const, error: null };
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: created, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({ response: failed, sequence_number: 1 }), 'response.failed'),
    sseFrame('[DONE]'),
  ));

  const events = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event : undefined));
  assertEquals(events.map(event => event?.type), ['response.created', 'response.in_progress', 'response.failed']);
  // Error payload must only be a real value on the terminal response.failed;
  // the synthesized created/in_progress carry `error: null` per spec
  // (Response.error is required-nullable).
  assertEquals((events[0] as { response: ResponsesResult }).response.error, null);
  assertEquals((events[1] as { response: ResponsesResult }).response.error, null);
  assertEquals((events[2] as { response: ResponsesResult }).response.error?.message, 'upstream failed');
});

// Asserts that when `response.failed` carries partial output, the fast-path
// expansion synthesises content_block events for that partial output before
// the terminal failed event so downstream clients can observe the partial
// work rather than losing it.
test('parseResponsesStream fast-paths response.failed terminal with partial output synthesised before the error', async () => {
  const failed = makeResponse('failed', {
    output_text: 'partial',
    output: [
      {
        type: 'message',
        id: 'msg_partial',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    ],
    error: { type: 'server_error', code: 'server_error', message: 'upstream failed mid-stream' },
  });
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: { ...failed, status: 'in_progress' }, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({ response: failed, sequence_number: 1 }), 'response.failed'),
    sseFrame('[DONE]'),
  ));

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.includes('response.output_item.added'), true);
  assertEquals(eventTypes.at(-1), 'response.failed');
});

test('parseResponsesStream fast-paths response.incomplete terminal', async () => {
  const incomplete = makeResponse('incomplete', {
    incomplete_details: { reason: 'max_output_tokens' } as ResponsesResult['incomplete_details'],
  });
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: { ...incomplete, status: 'in_progress' }, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({ response: incomplete, sequence_number: 1 }), 'response.incomplete'),
    sseFrame('[DONE]'),
  ));

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.at(-1), 'response.incomplete');
  assertEquals(eventTypes.includes('response.output_item.added'), true);
});

test('parseResponsesStream passes raw error terminal through (no .response to expand)', async () => {
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ message: 'connection reset', code: 'ECONNRESET' }), 'error'),
    sseFrame('[DONE]'),
  ));

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes, ['error']);
  const errorEvent = frames[0];
  assertEquals(errorEvent.type === 'event' && (errorEvent.event as { message?: string }).message, 'connection reset');
});

test('parseResponsesStream fast-paths when ping interleaves the wrappers', async () => {
  const completed = makeResponse('completed');
  const frames = await collect(parse(
    sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 0 }), 'response.created'),
    sseFrame(JSON.stringify({}), 'ping'),
    sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 1 }), 'response.in_progress'),
    sseFrame(JSON.stringify({}), 'ping'),
    sseFrame(JSON.stringify({ response: completed, sequence_number: 2 }), 'response.completed'),
    sseFrame('[DONE]'),
  ));

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.includes('response.output_item.added'), true);
  assertEquals(eventTypes.at(-1), 'response.completed');
  assertEquals(eventTypes.includes('ping'), false);
});
