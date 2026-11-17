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

test('chatFromCopilotRaw vision-only → modalities with image input', () => {
  const chat = chatFromCopilotRaw(rawModel({ vision: true }));
  assertEquals(chat, { modalities: { input: ['text', 'image'], output: ['text'] } });
});

test('chatFromCopilotRaw reasoning_effort with medium → default is medium', () => {
  const chat = chatFromCopilotRaw(rawModel({ reasoning_effort: ['low', 'medium', 'high'] }));
  assertEquals(chat, {
    reasoning: { effort: { supported: ['low', 'medium', 'high'], default: 'medium' } },
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

test('chatFromCopilotRaw adaptive_thinking: false → no chat', () => {
  assertEquals(chatFromCopilotRaw(rawModel({ adaptive_thinking: false })), undefined);
});
