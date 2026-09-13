import { expect, test } from 'vitest';

import {
  convertOpenAIResponsesTransport,
  openaiResponsesResultToEvents,
  type CanonicalOpenAIResponsesPayload,
  type OpenAIResponsesResult,
} from '../../src/openai-responses/index.ts';

test('Responses transports retain Astra async tools and durable reasoning controls', () => {
  const payload: CanonicalOpenAIResponsesPayload = {
    model: 'gpt-6-astra',
    tools: [
      { type: 'function', name: 'lookup', async: true },
      { type: 'namespace', name: 'workspace', description: '', tools: [{ type: 'custom', name: 'build', async: true }] },
    ],
    reasoning: { effort: 'low' },
    input: [
      { type: 'message', role: 'user', content: 'Investigate' },
      { type: 'function_call', name: 'lookup', call_id: 'call_pending', arguments: '{}', status: 'completed', async: true },
      { type: 'configuration_update', reasoning: { effort: 'future_effort' } },
      { type: 'message', role: 'user', content: 'Check the harder case while lookup runs.' },
      { type: 'function_call_output', call_id: 'call_pending', output: 'Found the result.' },
    ],
  };

  const lite = convertOpenAIResponsesTransport(payload, 'standard', 'lite');
  const restored = convertOpenAIResponsesTransport(lite, 'lite', 'standard');
  expect(restored.tools).toEqual(payload.tools);
  expect(restored.input).toEqual(payload.input);
  expect(restored.reasoning?.effort).toBe('low');
  expect(convertOpenAIResponsesTransport(payload, 'standard', 'standard')).toEqual(payload);
});

test('Responses JSON fallback preserves async execution on tool lifecycle events', () => {
  const result: OpenAIResponsesResult = {
    id: 'resp_astra', object: 'response', model: 'gpt-6-astra', status: 'completed',
    output: [
      { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{}', async: true, status: 'completed' },
      { type: 'custom_tool_call', id: 'ctc_build', call_id: 'call_build', namespace: 'workspace', name: 'build', input: 'build', async: true },
    ],
    error: null, incomplete_details: null,
  };
  const events = openaiResponsesResultToEvents(result).map(frame => frame.event);
  const added = events.filter(event => event.type === 'response.output_item.added');
  expect(added.map(event => event.item)).toMatchObject([
    { call_id: 'call_lookup', async: true },
    { call_id: 'call_build', namespace: 'workspace', async: true },
  ]);
  expect(events.at(-1)).toMatchObject({ type: 'response.completed', response: result });
});
