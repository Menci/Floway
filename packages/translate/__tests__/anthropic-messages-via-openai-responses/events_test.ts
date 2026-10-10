import { expect, test } from 'vitest';

import { translateToSourceEvents } from '../../src/anthropic-messages-via-openai-responses/events.ts';
import { testOutputTranslation } from '../shared/ir/translation-cases.ts';
import { parseAnthropicMessagesStream, collectAnthropicMessagesProtocolEventsToResult, anthropicMessagesProtocolFrameToSSEFrame } from '@floway-dev/protocols/anthropic-messages';
import { parseOpenAIResponsesStream } from '@floway-dev/protocols/openai-responses';

test('Responses late fixed usage reaches the Messages client through full usage delta', async () => {
  const response = { id: 'resp_usage', model: 'gpt-test', object: 'response', output: [], error: null, incomplete_details: null };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response: { ...response, status: 'completed', service_tier: 'priority', usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
  ];
  const sourceSSE = events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
  let clientSSE = '';
  for await (const frame of translateToSourceEvents(parseOpenAIResponsesStream(new Response(sourceSSE).body!))) {
    const sse = anthropicMessagesProtocolFrameToSSEFrame(frame);
    if (sse) clientSSE += `event: ${sse.event}\ndata: ${sse.data}\n\n`;
  }
  const result = await collectAnthropicMessagesProtocolEventsToResult(parseAnthropicMessagesStream(new Response(clientSSE).body!));
  expect(result.usage.service_tier).toBe('priority');
  expect(result.usage.input_tokens).toBe(3);
  expect(result.usage.output_tokens).toBe(4);
});

testOutputTranslation('anthropic-messages', 'openai-responses', frames => translateToSourceEvents(frames));
