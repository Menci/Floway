import { expect, test } from 'vitest';

import { buildSourceEventsFor, emptyPayload, pairs } from '../../composition/helpers.ts';
import { createTestSidecarCodec } from '../../round-trip/sidecar-codec.ts';
import { testOutputTranslation } from '../fixtures.ts';
import { parseAnthropicMessagesStream, collectAnthropicMessagesProtocolEventsToResult, anthropicMessagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/anthropic-messages';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';
import { routeAnthropicMessagesViaOpenAIResponses } from '@floway-dev/translate';

testOutputTranslation('anthropic-messages', 'openai-responses', (frames, codec) => {
  const [source, target] = pairs.messagesToResponses;
  return buildSourceEventsFor(source, target, emptyPayload.messages, { sidecarCodec: codec }, frames);
});

test('Responses late fixed usage reaches the Messages client through full usage delta', async () => {
  const response = { id: 'resp_usage', model: 'gpt-test', object: 'response', output: [], error: null, incomplete_details: null };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response: { ...response, status: 'completed', service_tier: 'priority', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ];
  const sourceSSE = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
  const trip = await routeAnthropicMessagesViaOpenAIResponses({ model: 'gpt-test', max_tokens: 64, stream: true, messages: [] }, { sidecarCodec: createTestSidecarCodec() });
  if (trip.type === 'input-error') throw new Error(trip.message);
  let clientSSE = '';
  for await (const frame of trip.events(parseOpenAIResponsesStream(new Response(sourceSSE).body!))) {
    const sse = anthropicMessagesProtocolFrameToSSEFrame(frame);
    if (sse) clientSSE += `event: ${sse.event}\ndata: ${sse.data}\n\n`;
  }
  const result = await collectAnthropicMessagesProtocolEventsToResult(parseAnthropicMessagesStream(new Response(clientSSE).body!));
  expect(result.usage.service_tier).toBe('priority');
  expect(result.usage.input_tokens).toBe(3);
  expect(result.usage.output_tokens).toBe(4);
});
