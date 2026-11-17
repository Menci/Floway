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

test('chatFromCopilotRaw combines vision, reasoning effort, budget, and adaptive thinking', () => {
  const chat = chatFromCopilotRaw(rawModel({
    vision: true,
    reasoning_effort: ['low', 'medium', 'high'],
    min_thinking_budget: 1024,
    max_thinking_budget: 32768,
    adaptive_thinking: true,
  }));
  assertEquals(chat, {
    modalities: { input: ['text', 'image'], output: ['text'] },
    reasoning: {
      effort: { supported: ['low', 'medium', 'high'], default: 'medium' },
      budget_tokens: { min: 1024, max: 32768 },
      adaptive: true,
    },
  });
});

test('chatFromCopilotRaw reasoning_effort without medium → default is first', () => {
  const chat = chatFromCopilotRaw(rawModel({ reasoning_effort: ['minimal', 'xhigh'] }));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['minimal', 'xhigh'], default: 'minimal' } },
  });
});
