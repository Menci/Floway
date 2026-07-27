import { test } from 'vitest';

import { chatFromCopilotRaw } from '../src/chat-from-raw.ts';
import type { CopilotRawModel } from '../src/types.ts';
import { assertEquals } from '@floway-dev/test-utils';

const rawModel = (supports: NonNullable<NonNullable<CopilotRawModel['capabilities']>['supports']>): CopilotRawModel => ({
  id: 'test-model',
  capabilities: { supports },
});

test('chatFromCopilotRaw returns undefined when capabilities.supports is absent', () => {
  assertEquals(chatFromCopilotRaw({ id: 'test-model' }), undefined);
  assertEquals(chatFromCopilotRaw({ id: 'test-model', capabilities: {} }), undefined);
  assertEquals(chatFromCopilotRaw({ id: 'test-model', capabilities: { type: 'chat' } }), undefined);
});

test('chatFromCopilotRaw returns undefined when supports has no recognized fields', () => {
  assertEquals(chatFromCopilotRaw(rawModel({})), undefined);
});

test('chatFromCopilotRaw vision-only → modalities with image input', () => {
  const chat = chatFromCopilotRaw(rawModel({ vision: true }));
  assertEquals(chat, { modalities: { input: ['text', 'image'], output: ['text'] } });
});

test('chatFromCopilotRaw vision: false → no modalities', () => {
  assertEquals(chatFromCopilotRaw(rawModel({ vision: false })), undefined);
});

test('chatFromCopilotRaw reasoning_effort with medium → default is medium', () => {
  const chat = chatFromCopilotRaw(rawModel({ reasoning_effort: ['low', 'medium', 'high'] }));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
  });
});

test('chatFromCopilotRaw reasoning_effort full GPT-5 set → default is medium', () => {
  const efforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  const chat = chatFromCopilotRaw(rawModel({ reasoning_effort: efforts }));
  assertEquals(chat, {
    reasoning: { effort: { supported: efforts, default: 'medium' } },
  });
});

test('chatFromCopilotRaw reasoning_effort without medium → default is first', () => {
  const chat = chatFromCopilotRaw(rawModel({ reasoning_effort: ['minimal', 'xhigh'] }));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['minimal', 'xhigh'], default: 'minimal' } },
  });
});

test('chatFromCopilotRaw min+max_thinking_budget → budget_tokens', () => {
  const chat = chatFromCopilotRaw(rawModel({ min_thinking_budget: 1024, max_thinking_budget: 16384 }));
  assertEquals(chat, {
    reasoning: { budget_tokens: { min: 1024, max: 16384 } },
  });
});

test('chatFromCopilotRaw min_thinking_budget only → budget_tokens.min', () => {
  const chat = chatFromCopilotRaw(rawModel({ min_thinking_budget: 512 }));
  assertEquals(chat, { reasoning: { budget_tokens: { min: 512 } } });
});

test('chatFromCopilotRaw max_thinking_budget only → budget_tokens.max', () => {
  const chat = chatFromCopilotRaw(rawModel({ max_thinking_budget: 8192 }));
  assertEquals(chat, { reasoning: { budget_tokens: { max: 8192 } } });
});

test('chatFromCopilotRaw adaptive_thinking: true → reasoning.adaptive', () => {
  const chat = chatFromCopilotRaw(rawModel({ adaptive_thinking: true }));
  assertEquals(chat, { reasoning: { adaptive: true } });
});

test('chatFromCopilotRaw adaptive_thinking: false → no chat', () => {
  assertEquals(chatFromCopilotRaw(rawModel({ adaptive_thinking: false })), undefined);
});

test('chatFromCopilotRaw combined: vision + reasoning_effort + adaptive_thinking → full chat', () => {
  const chat = chatFromCopilotRaw(rawModel({
    vision: true,
    reasoning_effort: ['low', 'medium', 'high', 'xhigh'],
    min_thinking_budget: 1024,
    max_thinking_budget: 32768,
    adaptive_thinking: true,
  }));
  assertEquals(chat, {
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: {
      effort: { supported: ['low', 'medium', 'high', 'xhigh'], default: 'medium' },
      budget_tokens: { min: 1024, max: 32768 },
      adaptive: true,
    },
  });
});
