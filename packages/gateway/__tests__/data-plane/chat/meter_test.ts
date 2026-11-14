import { afterEach, expect, test, vi } from 'vitest';

import { meterUsage } from '../../../src/data-plane/chat/openai-responses/meter.ts';
import { mockChatGatewayCtx } from '../../test-utils/gateway-ctx.ts';
import { compose, defineStage, move, run } from '@floway-dev/pipeline';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { OpenAIResponsesStreamEventEx } from '@floway-dev/protocols/openai-responses';
import { testTelemetryModelIdentity } from '@floway-dev/test-utils';

afterEach(() => { vi.restoreAllMocks(); });

test.each([false, true])('first output timing warns for a runtime result only when decode was absent: decode=%s', async decode => {
  const warn = vi.fn();
  const gateway = mockChatGatewayCtx();
  const runtime = eventFrame({ type: 'response.output_item.added', output_index: 0, item: { type: 'program_output', result: 'tool output' } });
  const response = { id: 'r', object: 'response', model: 'm', status: 'completed', output: [], error: null, incomplete_details: null } as const;
  const frames = (async function* () {
    yield eventFrame({ type: 'response.created', response: { ...response, status: 'in_progress' } });
    if (decode) yield eventFrame({ type: 'response.output_text.delta', output_index: 0, item_id: 'message', content_index: 0, delta: 'answer' });
    yield runtime;
    yield eventFrame({ type: 'response.completed', response });
  })() as AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>>;
  const ending = defineStage<Record<string, unknown>, Record<string, unknown>>({
    name: 'scriptedTimingDial', return: { provides: ['response.chat.openaiResponses', 'response.usage.billable'] },
    execute: async facts => move({ ...facts, 'response.chat.openaiResponses': { kind: 'stream', frames }, 'response.usage.billable': [{ identity: testTelemetryModelIdentity, quantities: {} }] }),
  });
  const executed = await run(compose<Record<string, unknown>, Record<string, unknown>>('timingUnderTest', [meterUsage('response.chat.openaiResponses.streamedUsage'), ending]), move({}), { gateway, log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } });
  const answer = executed.facts['response.chat.openaiResponses'] as { frames: AsyncIterable<ProtocolFrame<OpenAIResponsesStreamEventEx>> };
  const iterator = answer.frames[Symbol.asyncIterator]();
  expect(gateway.attempt.timing.firstOutputTokenAt).toBeNull();
  await iterator.next();
  expect(gateway.attempt.timing.firstOutputTokenAt).toBeNull();
  expect(warn).not.toHaveBeenCalled();
  vi.spyOn(performance, 'now').mockReturnValue(123);
  await iterator.next();
  expect(gateway.attempt.timing.firstOutputTokenAt).toBe(123);
  vi.mocked(performance.now).mockReturnValue(456);
  while (!(await iterator.next()).done) {}
  expect(gateway.attempt.timing.firstOutputTokenAt).toBe(123);
  if (decode) expect(warn).not.toHaveBeenCalled();
  else expect(warn).toHaveBeenCalledExactlyOnceWith('first output timing started from runtime output without an earlier decode signal in this response', { stage: 'meter:openaiResponses', outputType: 'program_output', upstream: testTelemetryModelIdentity.upstream, model: testTelemetryModelIdentity.model, modelKey: testTelemetryModelIdentity.modelKey });
  await executed.drain();
});
