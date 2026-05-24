import { test } from 'vitest';

import { withResponsesToolArgumentWhitespaceAborted } from './abort-on-tool-argument-whitespace.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { RequestContext, ResponsesInvocation } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import { MAX_CONSECUTIVE_WHITESPACE } from '../shared/whitespace-overflow.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

const invocation = (): ResponsesInvocation => ({
  sourceApi: 'responses',
  targetApi: 'responses',
  model: 'test-model',
  upstream: 'test-upstream',
  payload: {
    model: 'test-model',
    input: [] as unknown as ResponsesPayload['input'],
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
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const argsDelta = (outputIndex: number, delta: string): ResponsesStreamEvent =>
  ({
    type: 'response.function_call_arguments.delta',
    item_id: `fc_${outputIndex}`,
    output_index: outputIndex,
    delta,
  }) as ResponsesStreamEvent;

const collect = async (result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  if (result.type !== 'events') throw new Error('expected events');
  const out: ProtocolFrame<ResponsesStreamEvent>[] = [];
  for await (const frame of result.events) out.push(frame);
  return out;
};

const runWith = async (frames: ProtocolFrame<ResponsesStreamEvent>[]): Promise<ProtocolFrame<ResponsesStreamEvent>[]> => {
  const result = await withResponsesToolArgumentWhitespaceAborted(invocation(), stubRequest, () =>
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

test('passes a normal Responses stream through unchanged', async () => {
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, '{"k":')),
    eventFrame(argsDelta(0, '"v"}')),
    eventFrame(({ type: 'response.function_call_arguments.done', item_id: 'fc_0', output_index: 0, arguments: '{"k":"v"}' }) as ResponsesStreamEvent),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});

test('aborts and emits an error event + done when whitespace exceeds the threshold', async () => {
  const wsDelta = '\n'.repeat(MAX_CONSECUTIVE_WHITESPACE + 1);
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [
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
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [
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
  const frames: ProtocolFrame<ResponsesStreamEvent>[] = [
    eventFrame(argsDelta(0, args)),
    eventFrame(argsDelta(1, args)),
    doneFrame(),
  ];

  const out = await runWith(frames);
  assertEquals(out, frames);
});
