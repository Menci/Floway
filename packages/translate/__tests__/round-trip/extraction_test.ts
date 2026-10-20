import { expect, test } from 'vitest';

import { findAnthropicMessagesSidecarCarriers } from '../../src/protocols/anthropic-messages/as-source/round-trip.ts';
import { findGeminiGenerateContentSidecarCarriers } from '../../src/protocols/gemini-generate-content/as-source/round-trip.ts';
import { findOpenAIChatCompletionsSidecarCarriers } from '../../src/protocols/openai-chat-completions/as-source/round-trip.ts';
import { findOpenAIResponsesSidecarCarriers } from '../../src/protocols/openai-responses/as-source/round-trip.ts';

test('Chat enumerates encrypted details and removes only the chosen detail', () => {
  const details = [{ type: 'reasoning.encrypted', data: 'before' }, { type: 'reasoning.encrypted', data: 'chosen' }, { type: 'reasoning.summary', summary: 'summary' }, { type: 'reasoning.encrypted', data: 'after' }];
  const turn = { role: 'assistant' as const, content: 'answer', reasoning_content: 'thought', reasoning_details: details };
  const before = structuredClone(turn);
  const candidates = findOpenAIChatCompletionsSidecarCarriers(turn);
  expect(candidates.map(candidate => candidate.data)).toEqual(['before', 'chosen', 'after']);
  expect(candidates[1].withoutSidecar()).toEqual({ ...turn, reasoning_details: [details[0], details[2], details[3]] });
  expect(turn).toEqual(before);
});

test('Messages enumerates every block across string and empty trailing messages', () => {
  const content = [
    { type: 'redacted_thinking' as const, data: 'before' }, { type: 'redacted_thinking' as const, data: 'chosen' },
    { type: 'text' as const, text: 'answer' }, { type: 'thinking' as const, thinking: 'thought', signature: 'native' },
    { type: 'redacted_thinking' as const, data: 'after' },
  ];
  const turn: Parameters<typeof findAnthropicMessagesSidecarCarriers>[0] = [{ role: 'assistant', content }, { role: 'assistant', content: '' }, { role: 'assistant', content: [] }];
  const before = structuredClone(turn);
  const candidates = findAnthropicMessagesSidecarCarriers(turn);
  expect(candidates.map(candidate => candidate.data)).toEqual(['before', 'chosen', 'after']);
  expect(candidates[1].withoutSidecar()).toEqual([{ ...turn[0], content: [content[0], ...content.slice(2)] }, ...turn.slice(1)]);
  expect(turn).toEqual(before);
});

test('Responses enumerates every encrypted item and preserves the selected readable body and metadata', () => {
  const turn: Parameters<typeof findOpenAIResponsesSidecarCarriers>[0] = [
    { type: 'reasoning', id: 'before', summary: [], encrypted_content: 'before' },
    { type: 'reasoning', id: 'native', status: 'incomplete', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }], encrypted_content: 'chosen' },
    { type: 'reasoning', id: 'after', status: 'completed', summary: [], encrypted_content: 'after' },
    { type: 'message', role: 'assistant', content: [] },
  ];
  const before = structuredClone(turn);
  const candidates = findOpenAIResponsesSidecarCarriers(turn);
  expect(candidates.map(candidate => candidate.data)).toEqual(['before', 'chosen', 'after']);
  expect(candidates[1].withoutSidecar()).toEqual([turn[0], {
    type: 'reasoning', id: 'native', status: 'incomplete', summary: [{ type: 'summary_text', text: 'summary' }], content: [{ type: 'reasoning_text', text: 'thought' }],
  }, ...turn.slice(2)]);
  expect(candidates[0].withoutSidecar()).toEqual(turn.slice(1));
  expect(turn).toEqual(before);
});

test('Responses treats Codex null reasoning content as absent when removing a sidecar', () => {
  const turn = [{
    type: 'reasoning', id: 'native', summary: [], content: null, encrypted_content: 'sidecar',
  }] as unknown as Parameters<typeof findOpenAIResponsesSidecarCarriers>[0];
  const candidates = findOpenAIResponsesSidecarCarriers(turn);
  expect(candidates).toHaveLength(1);
  expect(candidates[0].withoutSidecar()).toEqual([]);
});

test('GenerateContent enumerates attached and standalone signatures across empty trailing contents', () => {
  const parts = [
    { text: 'answer', thoughtSignature: 'on-text' },
    { functionCall: { name: 'lookup', args: {} }, thoughtSignature: 'on-call' },
    { thoughtSignature: 'standalone-part' },
  ];
  const turn: Parameters<typeof findGeminiGenerateContentSidecarCarriers>[0] = [{ role: 'model', parts }, { role: 'model', parts: [{ thoughtSignature: 'standalone-content' }] }, { role: 'model' }, { role: 'model', parts: [] }];
  const before = structuredClone(turn);
  const candidates = findGeminiGenerateContentSidecarCarriers(turn);
  expect(candidates.map(candidate => candidate.data)).toEqual(['on-text', 'on-call', 'standalone-part', 'standalone-content']);
  expect(candidates[0].withoutSidecar()).toEqual([{ ...turn[0], parts: [{ text: 'answer' }, ...parts.slice(1)] }, ...turn.slice(1)]);
  expect(candidates[1].withoutSidecar()).toEqual([{ ...turn[0], parts: [parts[0], { functionCall: { name: 'lookup', args: {} } }, parts[2]] }, ...turn.slice(1)]);
  expect(candidates[3].withoutSidecar()).toEqual([turn[0], ...turn.slice(2)]);
  expect(turn).toEqual(before);
});
