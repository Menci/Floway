import { expect, test } from 'vitest';

import { inspectAnthropicMessagesAssistantTurn } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { inspectGeminiGenerateContentAssistantTurn } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { inspectOpenAIChatCompletionsAssistantTurn } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { inspectOpenAIResponsesAssistantTurn } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

test('Chat extraction preserves ordinary reasoning details', () => {
  const turn: Parameters<typeof inspectOpenAIChatCompletionsAssistantTurn>[0] = {
    role: 'assistant', content: 'answer', reasoning_content: 'thought',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'earlier' }, { type: 'reasoning.summary', summary: 'summary' }, { type: 'reasoning.encrypted', data: 'opaque' }],
  };
  const before = structuredClone(turn);
  expect(inspectOpenAIChatCompletionsAssistantTurn(turn)).toEqual({
    sidecar: 'opaque', turn: { ...turn, reasoning_details: [{ type: 'reasoning.encrypted', data: 'earlier' }, { type: 'reasoning.summary', summary: 'summary' }] },
  });
  expect(turn).toEqual(before);
});

test('Messages extraction preserves ordinary thinking', () => {
  const turn: Parameters<typeof inspectAnthropicMessagesAssistantTurn>[0] = [{
    role: 'assistant', content: [
      { type: 'redacted_thinking', data: 'earlier' }, { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'thought', signature: 'native' },
      { type: 'redacted_thinking', data: 'opaque' },
    ],
  }];
  const before = structuredClone(turn);
  expect(inspectAnthropicMessagesAssistantTurn(turn)).toEqual({
    sidecar: 'opaque', turn: [{
      role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'earlier' }, { type: 'text', text: 'answer' }, { type: 'thinking', thinking: 'thought', signature: 'native' },
      ],
    }],
  });
  expect(turn).toEqual(before);
});

test('Responses extraction preserves earlier encrypted reasoning and removes only the terminal carrier', () => {
  const turn: Parameters<typeof inspectOpenAIResponsesAssistantTurn>[0] = [
    { type: 'reasoning', id: 'native', status: 'incomplete', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }], encrypted_content: 'attached' },
    { type: 'reasoning', id: 'carrier', status: 'completed', summary: [], encrypted_content: 'standalone' },
  ];
  const before = structuredClone(turn);
  expect(inspectOpenAIResponsesAssistantTurn(turn)).toEqual({
    sidecar: 'standalone', turn: [turn[0]],
  });
  expect(turn).toEqual(before);
});

test('GenerateContent extraction preserves every earlier signature and content', () => {
  const turn: Parameters<typeof inspectGeminiGenerateContentAssistantTurn>[0] = [{
    role: 'model', parts: [
      { text: 'answer', thoughtSignature: 'on-text' },
      { functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'on-call' },
      { thoughtSignature: 'standalone-part' },
    ],
  }, { role: 'model', parts: [{ thoughtSignature: 'standalone-content' }] }];
  const before = structuredClone(turn);
  expect(inspectGeminiGenerateContentAssistantTurn(turn)).toEqual({
    sidecar: 'standalone-content', turn: [turn[0]],
  });
  expect(turn).toEqual(before);
});

test('Chat does not select an encrypted detail before the terminal detail', () => {
  const turn: Parameters<typeof inspectOpenAIChatCompletionsAssistantTurn>[0] = {
    role: 'assistant', content: 'answer', reasoning_details: [{ type: 'reasoning.encrypted', data: 'earlier' }, { type: 'reasoning.summary', summary: 'last' }],
  };
  expect(inspectOpenAIChatCompletionsAssistantTurn(turn)).toEqual({ turn });
});

test('Messages never searches backward past an ordinary, string, or empty terminal unit', () => {
  const first: Parameters<typeof inspectAnthropicMessagesAssistantTurn>[0][number] = { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'earlier' }] };
  const turns: Parameters<typeof inspectAnthropicMessagesAssistantTurn>[0][] = [
    [first, { role: 'assistant', content: '' }],
    [first, { role: 'assistant', content: [] }],
    [{ role: 'assistant', content: [{ type: 'redacted_thinking', data: 'earlier' }, { type: 'text', text: 'last' }] }],
  ];
  for (const turn of turns) expect(inspectAnthropicMessagesAssistantTurn(turn)).toEqual({ turn });
});

test('Responses does not select encrypted reasoning before the terminal item', () => {
  const turn: Parameters<typeof inspectOpenAIResponsesAssistantTurn>[0] = [
    { type: 'reasoning', summary: [], encrypted_content: 'earlier' }, { type: 'message', role: 'assistant', content: 'last' },
  ];
  expect(inspectOpenAIResponsesAssistantTurn(turn)).toEqual({ turn });
});

test('GenerateContent never searches backward past an ordinary part or empty terminal content', () => {
  const first = { role: 'model', parts: [{ thoughtSignature: 'earlier' }] };
  const turns: Parameters<typeof inspectGeminiGenerateContentAssistantTurn>[0][] = [
    [first, { role: 'model' }], [first, { role: 'model', parts: [] }],
    [{ role: 'model', parts: [{ thoughtSignature: 'earlier' }, { text: 'last' }] }],
  ];
  for (const turn of turns) expect(inspectGeminiGenerateContentAssistantTurn(turn)).toEqual({ turn });
});

test.each([{ text: 'answer' }, { functionCall: { name: 'lookup', args: { q: 'value' } } }])('GenerateContent preserves the body attached to its selected terminal signature: %j', body => {
  const turn = [{ role: 'model', parts: [{ ...body, thoughtSignature: 'selected' }] }];
  expect(inspectGeminiGenerateContentAssistantTurn(turn)).toEqual({ sidecar: 'selected', turn: [{ role: 'model', parts: [body] }] });
});
