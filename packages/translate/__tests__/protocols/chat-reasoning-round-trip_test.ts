import { expect, test } from 'vitest';

import { toOpenAIResponsesInputAssistantTurn } from '../../src/protocols/openai-responses/as-target/assistant-turn.ts';
import { createTestSidecarCodec } from '../round-trip/sidecar-codec.ts';
import { doneFrame, eventFrame } from '@floway-dev/protocols/common';
import type { OpenAIChatCompletionsAssistantDeltaEx, OpenAIChatCompletionsStreamEvent } from '@floway-dev/protocols/openai-chat-completions';
import { reassembleOpenAIResponsesEvents } from '@floway-dev/protocols/openai-responses';
import { routeOpenAIResponses } from '@floway-dev/translate/openai-responses';

const chunk = (delta: OpenAIChatCompletionsAssistantDeltaEx, finish_reason: 'stop' | null = null) => eventFrame<OpenAIChatCompletionsStreamEvent>({
  id: 'native', model: 'target', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason }],
});

test('round-trips native Chat reasoning fragments through Responses without corrupting detail identity', async () => {
  const context = { model: 'target', sidecarCodec: createTestSidecarCodec() };
  const trip = await routeOpenAIResponses({ model: 'source', input: [{ role: 'user', content: 'question' }] }).viaOpenAIChatCompletions(context);
  const upstream = async function* () {
    yield chunk({ role: 'assistant', reasoning_details: [{ type: 'reasoning.summary', summary: ' reading', id: 'summary', index: 0, format: 'openai-responses-v1' }] });
    yield chunk({ reasoning_details: [{ type: 'reasoning.summary', summary: ' it.', id: 'summary', index: 0, format: 'openai-responses-v1' }] });
    yield chunk({ reasoning_details: [{ type: 'reasoning.encrypted', data: 'native-opaque-data', id: 'encrypted', index: 0, format: 'openai-responses-v1' }] });
    yield chunk({ content: 'answer', provider_specific_fields: { trace: 'native' } }, 'stop');
    yield doneFrame();
  };
  const responseEvents = async function* () {
    for await (const frame of trip.events(upstream())) if (frame.type === 'event') yield frame.event;
  };
  const result = await reassembleOpenAIResponsesEvents(responseEvents());
  const restored = await routeOpenAIResponses({ model: 'source', input: toOpenAIResponsesInputAssistantTurn(result.output) }).viaOpenAIChatCompletions(context);
  expect(restored.target.messages).toEqual([{
    role: 'assistant', content: 'answer', refusal: null, provider_specific_fields: { trace: 'native' },
    reasoning_details: [
      { type: 'reasoning.summary', summary: ' reading it.', id: 'summary', index: 0, format: 'openai-responses-v1' },
      { type: 'reasoning.encrypted', data: 'native-opaque-data', id: 'encrypted', index: 0, format: 'openai-responses-v1' },
    ],
  }]);
});
