import { test } from 'vitest';

import { withToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import type { ChatCompletionsBoundaryCtx } from './types.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../shared/whitespace-overflow.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assert, assertEquals, assertStringIncludes, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const invocation = (): ChatCompletionsBoundaryCtx => ({
  payload: { model: 'test-model', messages: [] },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { chatCompletions: {} } }),
});

const stubRequest = {};

const baseChunk = (overrides: Partial<ChatCompletionsStreamEvent>): ChatCompletionsStreamEvent => ({
  id: 'chatcmpl_1',
  object: 'chat.completion.chunk',
  created: 0,
  model: 'test-model',
  choices: [],
  ...overrides,
});

const collect = async (result: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events');
  const out: ProtocolFrame<ChatCompletionsStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWith = async (frames: ProtocolFrame<ChatCompletionsStreamEvent>[]): Promise<ProtocolFrame<ChatCompletionsStreamEvent>[]> => {
  const result = await withToolArgumentWhitespaceAborted(invocation(), stubRequest, () =>
    Promise.resolve(
      eventResult(
        (async function* () {
          for (const frame of frames) yield frame;
        })(),
        testTelemetryModelIdentity,
      ),
    ));
  return await collect(result);
};

const runExpectingThrow = async (frames: ProtocolFrame<ChatCompletionsStreamEvent>[]): Promise<Error> => {
  try {
    await runWith(frames);
  } catch (err) {
    assert(err instanceof Error, 'expected an Error');
    return err;
  }
  throw new Error('expected the interceptor to throw');
};

test('passes a normal stream through unchanged', async () => {
  const frames: ProtocolFrame<ChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'do_thing', arguments: '{"k":"v"}' } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
    eventFrame(baseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});

test('throws when whitespace exceeds the threshold', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1);
  const frames: ProtocolFrame<ChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        id: 'chatcmpl_abort',
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'noop', arguments: args } }] },
            finish_reason: null,
          },
        ],
      }),
    ),
    // Subsequent frames should not be observed.
    eventFrame(baseChunk({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '\n\n\n' } }] }, finish_reason: null }] })),
    doneFrame(),
  ];

  const err = await runExpectingThrow(frames);
  assertStringIncludes(err.message, 'excessive consecutive whitespace');
});

test('continues streaming when whitespace is broken by non-whitespace characters', async () => {
  // Threshold + 1 line breaks split across two deltas with a non-whitespace
  // character in the middle resets the counter.
  const half = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const frames: ProtocolFrame<ChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'noop', arguments: half } }] }, finish_reason: null },
        ],
      }),
    ),
    eventFrame(
      baseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'x' } }] }, finish_reason: null },
        ],
      }),
    ),
    eventFrame(
      baseChunk({
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: half } }] }, finish_reason: null },
        ],
      }),
    ),
    eventFrame(baseChunk({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});

test('tracks whitespace per tool-call index independently', async () => {
  // Two distinct tool calls in parallel; each near but below threshold.
  // Neither should trigger abort because the per-index counters are separate.
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const frames: ProtocolFrame<ChatCompletionsStreamEvent>[] = [
    eventFrame(
      baseChunk({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'call_a', type: 'function', function: { name: 'a', arguments: args } },
                { index: 1, id: 'call_b', type: 'function', function: { name: 'b', arguments: args } },
              ],
            },
            finish_reason: null,
          },
        ],
      }),
    ),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});
