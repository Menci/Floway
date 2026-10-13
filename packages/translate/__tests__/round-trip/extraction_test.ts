import { expect, test } from 'vitest';

import { inspectAnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { inspectGeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { inspectOpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { inspectOpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

test('Chat extraction preserves ordinary reasoning details', () => {
  const turn: Parameters<typeof inspectOpenAIChatCompletionsAssistantTurn>[0] = {
    role: 'assistant', content: 'answer', reasoning_content: 'thought',
    reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }, { type: 'reasoning.encrypted', data: 'opaque' }],
  };
  const before = structuredClone(turn);
  expect(inspectOpenAIChatCompletionsAssistantTurn(turn)).toEqual({
    sidecars: ['opaque'], turn: { ...turn, reasoning_details: [{ type: 'reasoning.summary', summary: 'summary' }] },
  });
  expect(turn).toEqual(before);
});

test('Messages extraction preserves ordinary thinking', () => {
  const turn: Parameters<typeof inspectAnthropicMessagesAssistantTurn>[0] = [{
    role: 'assistant', content: [
      { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'thought', signature: 'native' },
      { type: 'redacted_thinking', data: 'opaque' },
    ],
  }];
  const before = structuredClone(turn);
  expect(inspectAnthropicMessagesAssistantTurn(turn)).toEqual({
    sidecars: ['opaque'], turn: [{
      role: 'assistant', content: [
        { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'thought', signature: 'native' },
      ],
    }],
  });
  expect(turn).toEqual(before);
});

test('Responses extraction preserves readable reasoning and status while removing empty carriers', () => {
  const turn: Parameters<typeof inspectOpenAIResponsesAssistantTurn>[0] = [
    { type: 'reasoning', id: 'native', status: 'incomplete', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }], encrypted_content: 'attached' },
    { type: 'reasoning', id: 'carrier', status: 'completed', summary: [], encrypted_content: 'standalone' },
  ];
  const before = structuredClone(turn);
  expect(inspectOpenAIResponsesAssistantTurn(turn)).toEqual({
    sidecars: ['attached', 'standalone'], turn: [
      { type: 'reasoning', id: 'native', status: 'incomplete', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }] },
    ],
  });
  expect(turn).toEqual(before);
});

test('GenerateContent extraction preserves attached text and tool data', () => {
  const turn: Parameters<typeof inspectGeminiGenerateContentAssistantTurn>[0] = [{
    role: 'model', parts: [
      { text: 'answer', thoughtSignature: 'on-text' },
      { functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'on-call' },
      { thoughtSignature: 'standalone-part' },
    ],
  }, { role: 'model', parts: [{ thoughtSignature: 'standalone-content' }] }];
  const before = structuredClone(turn);
  expect(inspectGeminiGenerateContentAssistantTurn(turn)).toEqual({
    sidecars: ['on-text', 'on-call', 'standalone-part', 'standalone-content'],
    turn: [{ role: 'model', parts: [{ text: 'answer' }, { functionCall: { name: 'lookup', args: {} } }] }],
  });
  expect(turn).toEqual(before);
});
