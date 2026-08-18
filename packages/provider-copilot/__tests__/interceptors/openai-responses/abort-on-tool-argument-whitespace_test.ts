import { test } from 'vitest';

import { withToolArgumentWhitespaceAborted } from '../../../src/interceptors/openai-responses/abort-on-tool-argument-whitespace.ts';
import type { OpenAIResponsesBoundaryCtx } from '../../../src/interceptors/openai-responses/types.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../../../src/interceptors/shared/whitespace-overflow.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEvent } from '@floway-dev/protocols/openai-responses';
import type { ProviderOpenAIResponsesResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel } from '@floway-dev/test-utils';

const invocation = (): OpenAIResponsesBoundaryCtx => ({
  payload: {
    model: 'test-model',
    input: [],
    instructions: null,
    temperature: 1,
    top_p: null,
    max_output_tokens: 32,
    tools: null,
    tool_choice: 'auto',
    metadata: null,
    stream: true,
    store: false,
    parallel_tool_calls: true,
  },
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { responses: {} } }),
  action: 'generate',
});

const stubRequest = {};

const argsDelta = (outputIndex: number, delta: string): OpenAIResponsesStreamEvent =>
  ({
    type: 'response.function_call_arguments.delta',
    item_id: `fc_${outputIndex}`,
    output_index: outputIndex,
    delta,
  }) as OpenAIResponsesStreamEvent;

const collect = async (result: ProviderOpenAIResponsesResult): Promise<ProtocolFrame<OpenAIResponsesStreamEvent>[]> => {
  if (result.action !== 'generate' || !result.ok) throw new Error('expected generate/ok result');
  const out: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWith = async (frames: ProtocolFrame<OpenAIResponsesStreamEvent>[]): Promise<ProtocolFrame<OpenAIResponsesStreamEvent>[]> => {
  const result = await withToolArgumentWhitespaceAborted(invocation(), stubRequest, () =>
    Promise.resolve<ProviderOpenAIResponsesResult>({
      action: 'generate',
      ok: true,
      events: (async function* () {
        for (const frame of frames) yield frame;
      })(),
      modelKey: 'test-model-key',
    }));
  return await collect(result);
};

test('passes a normal OpenAI Responses stream through unchanged', async () => {
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, '{"k":')),
    eventFrame(argsDelta(0, '"v"}')),
    eventFrame(({ type: 'response.function_call_arguments.done', item_id: 'fc_0', output_index: 0, arguments: '{"k":"v"}' }) as OpenAIResponsesStreamEvent),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});

test('aborts and emits an error event + done when whitespace exceeds the threshold', async () => {
  const wsDelta = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, wsDelta)),
    // Should not be observed: interceptor aborts on the first offending delta.
    eventFrame(argsDelta(0, '\n\n\n')),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out.length, 2);

  const first = out[0];
  if (first.type !== 'event') throw new Error('expected event frame');
  assertEquals(first.event.type, 'error');
  assertEquals((first.event as { message?: string }).message, 'Tool call arguments contained excessive whitespace, indicating a degenerate response.');

  assertEquals(out[1], doneFrame());
});

test('continues streaming when whitespace is broken by non-whitespace characters', async () => {
  const half = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, half)),
    eventFrame(argsDelta(0, 'x')),
    eventFrame(argsDelta(0, half)),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});

test('tracks whitespace per output index independently', async () => {
  const args = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE);
  const frames: ProtocolFrame<OpenAIResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, args)),
    eventFrame(argsDelta(1, args)),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});
