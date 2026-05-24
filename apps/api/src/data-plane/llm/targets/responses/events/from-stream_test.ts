import { test } from 'vitest';

import { responsesStreamFramesToEvents } from './from-stream.ts';
import { assertEquals, assertRejects } from '../../../../../test-assert.ts';
import { eventFrame, sseFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult } from '@floway-dev/protocols/responses';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makeResponse = (status: ResponsesResult['status'], overrides: Partial<ResponsesResult> = {}): ResponsesResult => ({
  id: 'resp_fast',
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
  ...overrides,
});

test('responsesStreamFramesToEvents parses Responses SSE frames into protocol events', async () => {
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(
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
        );
        yield sseFrame(
          JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
            sequence_number: 1,
          }),
        );
        yield sseFrame('[DONE]');
      })(),
    ),
  );

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

test('responsesStreamFramesToEvents rejects malformed Responses SSE JSON', async () => {
  await assertRejects(
    async () => {
      await collect(
        responsesStreamFramesToEvents(
          (async function* () {
            yield sseFrame('not json', 'response.output_text.delta');
          })(),
        ),
      );
    },
    Error,
    'Malformed upstream Responses SSE JSON for event "response.output_text.delta": not json',
  );
});

test('responsesStreamFramesToEvents expands upstream fast-path (created+in_progress+completed) into the full structured sequence', async () => {
  const response = makeResponse('completed');
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ response, sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({ response, sequence_number: 1 }), 'response.in_progress');
        yield sseFrame(JSON.stringify({ response, sequence_number: 2 }), 'response.completed');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

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

test('responsesStreamFramesToEvents passes wrapper frames through before a delayed fast-path terminal', async () => {
  const response = makeResponse('completed');
  let releaseTerminal!: () => void;
  const terminalReady = new Promise<void>(resolve => {
    releaseTerminal = resolve;
  });
  const iterator = responsesStreamFramesToEvents(
    (async function* () {
      yield sseFrame(JSON.stringify({ response: { ...response, status: 'in_progress' }, sequence_number: 0 }), 'response.created');
      yield sseFrame(JSON.stringify({ response: { ...response, status: 'in_progress' }, sequence_number: 1 }), 'response.in_progress');
      await terminalReady;
      yield sseFrame(JSON.stringify({ response, sequence_number: 2 }), 'response.completed');
      yield sseFrame('[DONE]');
    })(),
  )[Symbol.asyncIterator]();

  const first = await iterator.next();
  assertEquals(first.value, eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress' }, sequence_number: 0 }));

  const second = await iterator.next();
  assertEquals(second.value, eventFrame({ type: 'response.in_progress', response: { ...response, status: 'in_progress' }, sequence_number: 1 }));

  releaseTerminal();
  const rest = [];
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    rest.push(next.value);
  }

  assertEquals(
    rest.map(frame => (frame.type === 'event' ? frame.event.type : frame.type)),
    [
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
});

test('responsesStreamFramesToEvents passes structured upstream events through unchanged when upstream already streams them', async () => {
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(
          JSON.stringify({
            response: { ...makeResponse('in_progress'), output: [], output_text: '' },
            sequence_number: 0,
          }),
          'response.created',
        );
        yield sseFrame(
          JSON.stringify({
            type: 'response.output_item.added',
            output_index: 0,
            item: { type: 'message', role: 'assistant', content: [] },
            sequence_number: 1,
          }),
        );
        yield sseFrame(
          JSON.stringify({
            type: 'response.output_text.delta',
            item_id: 'msg_1',
            output_index: 0,
            content_index: 0,
            delta: 'hello',
            sequence_number: 2,
          }),
        );
        yield sseFrame(
          JSON.stringify({
            response: makeResponse('completed'),
            sequence_number: 3,
          }),
          'response.completed',
        );
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  // All four event sequence numbers from upstream survive verbatim — no fast-path expansion.
  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [0, 1, 2, 3]);
});

test('responsesStreamFramesToEvents does not duplicate wrappers when fast-path expansion kicks in', async () => {
  // Wrappers have already been forwarded downstream, so fast-path expansion
  // synthesizes only the remaining content and terminal events.
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ response: makeResponse('in_progress'), sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({ response: makeResponse('in_progress'), sequence_number: 1 }), 'response.in_progress');
        yield sseFrame(JSON.stringify({ response: makeResponse('completed'), sequence_number: 2 }), 'response.completed');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  // The upstream wrapper sequence numbers are kept and the synthesized content
  // continues from the canonical responseResultToEvents ordering.
  const sequenceNumbers = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? (frame.event as { sequence_number?: number }).sequence_number : undefined));
  assertEquals(sequenceNumbers, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
});

test('responsesStreamFramesToEvents fast-paths response.failed terminal with error preserved on terminal only', async () => {
  const failed = makeResponse('failed', {
    output: [],
    output_text: '',
    error: { type: 'server_error', code: 'server_error', message: 'upstream failed' },
  });
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        const { error: _error, ...created } = failed;
        yield sseFrame(JSON.stringify({ response: { ...created, status: 'in_progress' }, sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({ response: failed, sequence_number: 1 }), 'response.failed');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  const events = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event : undefined));
  assertEquals(events.map(event => event?.type), ['response.created', 'response.in_progress', 'response.failed']);
  // Error payload must only be on the terminal response.failed, not the synthesized created/in_progress.
  assertEquals((events[0] as { response: ResponsesResult }).response.error, undefined);
  assertEquals((events[1] as { response: ResponsesResult }).response.error, undefined);
  assertEquals((events[2] as { response: ResponsesResult }).response.error?.message, 'upstream failed');
});

// Locks in the deliberate behavior change: when response.failed carries partial output,
// the fast-path expansion synthesises content_block events for that partial output before
// the terminal failed event, so downstream clients can observe the partial work instead of
// losing it. Translate previously dropped any partial content on failed terminals.
test('responsesStreamFramesToEvents fast-paths response.failed terminal with partial output synthesised before the error', async () => {
  const failed = makeResponse('failed', {
    output_text: 'partial',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    ],
    error: { type: 'server_error', code: 'server_error', message: 'upstream failed mid-stream' },
  });
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ response: { ...failed, status: 'in_progress' }, sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({ response: failed, sequence_number: 1 }), 'response.failed');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.includes('response.output_item.added'), true);
  assertEquals(eventTypes.at(-1), 'response.failed');
});

test('responsesStreamFramesToEvents fast-paths response.incomplete terminal', async () => {
  const incomplete = makeResponse('incomplete', {
    incomplete_details: { reason: 'max_output_tokens' } as ResponsesResult['incomplete_details'],
  });
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ response: { ...incomplete, status: 'in_progress' }, sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({ response: incomplete, sequence_number: 1 }), 'response.incomplete');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.at(-1), 'response.incomplete');
  assertEquals(eventTypes.includes('response.output_item.added'), true);
});

test('responsesStreamFramesToEvents passes raw error terminal through (no .response to expand)', async () => {
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ message: 'connection reset', code: 'ECONNRESET' }), 'error');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes, ['error']);
  const errorEvent = frames[0];
  assertEquals(errorEvent.type === 'event' && (errorEvent.event as { message?: string }).message, 'connection reset');
});

test('responsesStreamFramesToEvents fast-paths when ping interleaves the wrappers', async () => {
  const completed = makeResponse('completed');
  const frames = await collect(
    responsesStreamFramesToEvents(
      (async function* () {
        yield sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 0 }), 'response.created');
        yield sseFrame(JSON.stringify({}), 'ping');
        yield sseFrame(JSON.stringify({ response: { ...completed, status: 'in_progress' }, sequence_number: 1 }), 'response.in_progress');
        yield sseFrame(JSON.stringify({}), 'ping');
        yield sseFrame(JSON.stringify({ response: completed, sequence_number: 2 }), 'response.completed');
        yield sseFrame('[DONE]');
      })(),
    ),
  );

  const eventTypes = frames.filter(frame => frame.type === 'event').map(frame => (frame.type === 'event' ? frame.event.type : ''));
  assertEquals(eventTypes.includes('response.output_item.added'), true);
  assertEquals(eventTypes.at(-1), 'response.completed');
  assertEquals(eventTypes.includes('ping'), false);
});
