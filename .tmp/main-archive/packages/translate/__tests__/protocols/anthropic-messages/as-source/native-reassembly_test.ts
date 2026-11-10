import { expect, test, vi } from 'vitest';

import { computeAnthropicMessagesTurnDigest } from '../../../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { createTestSidecarCodec } from '../../../round-trip/sidecar-codec.ts';
import { createAnthropicMessagesEventAccumulator, reassembleAnthropicMessagesEvents } from '@floway-dev/protocols/anthropic-messages';
import { openaiResponsesResultToEvents } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessages } from '@floway-dev/translate/anthropic-messages';

vi.mock('@floway-dev/protocols/anthropic-messages', async importOriginal => {
  const actual = await importOriginal<typeof import('@floway-dev/protocols/anthropic-messages')>();
  return {
    ...actual,
    createAnthropicMessagesEventAccumulator: vi.fn(() => {
      const accumulator = actual.createAnthropicMessagesEventAccumulator();
      return { ...accumulator, contentBlock: vi.fn(accumulator.contentBlock), result: vi.fn(accumulator.result) };
    }),
  };
});

test.each(['complete', 'truncated'] as const)('reads only the current native block for %s tool inputs', async mode => {
  vi.mocked(createAnthropicMessagesEventAccumulator).mockClear();
  const count = 32;
  const codec = createTestSidecarCodec();
  const trip = await routeAnthropicMessages({
    model: 'source', max_tokens: 4096, messages: [{ role: 'user', content: 'question' }],
  }).viaOpenAIResponses({ model: 'target', sidecarCodec: codec });
  const frames = async function* () {
    yield* openaiResponsesResultToEvents({
      id: 'response', object: 'response', model: 'target',
      status: mode === 'complete' ? 'completed' : 'incomplete',
      output: Array.from({ length: count }, (_, index) => ({
        type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name: 'lookup',
        arguments: mode === 'complete' ? `{"index":${index}}` : `{"index":${index},"unfinished":`,
        status: mode === 'complete' ? 'completed' : 'incomplete',
      })),
      error: null, incomplete_details: mode === 'complete' ? null : { reason: 'max_output_tokens' },
      usage: { input_tokens: 1, output_tokens: count, total_tokens: count + 1 },
    });
  };
  const events = async function* () {
    for await (const frame of trip.events(frames())) if (frame.type === 'event') yield frame.event;
  };
  const result = await reassembleAnthropicMessagesEvents(events());
  const tools = Array.from({ length: count }, (_, index) => ({
    type: 'tool_use' as const, id: `call_${index}`, name: 'lookup', input: { index },
  }));
  expect(result.content.filter(block => block.type === 'tool_use')).toEqual(tools);
  const carrier = result.content.find(block => block.type === 'redacted_thinking');
  if (carrier?.type !== 'redacted_thinking') throw new Error('Expected a round-trip sidecar');
  expect(await codec.decode(carrier.data)).toMatchObject({
    sourceTurnDigest: await computeAnthropicMessagesTurnDigest([{ role: 'assistant', content: tools }]),
  });
  expect(createAnthropicMessagesEventAccumulator).toHaveBeenCalledTimes(1);
  const creation = vi.mocked(createAnthropicMessagesEventAccumulator).mock.results[0];
  if (creation.type !== 'return') throw new Error('Expected the native accumulator');
  expect(creation.value.result).toHaveBeenCalledTimes(1);
  expect(creation.value.contentBlock).toHaveBeenCalledTimes(mode === 'complete' ? 0 : count);
});
