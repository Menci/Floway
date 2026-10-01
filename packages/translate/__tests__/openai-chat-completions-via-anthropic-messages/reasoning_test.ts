import { afterEach, expect, test, vi } from 'vitest';

import { thinkingBlocksFromChatCompletions } from '../../src/openai-chat-completions-via-anthropic-messages/reasoning.ts';
import { flowayReasoningFields, encodeChatCompletionsReasoningData } from '@floway-dev/protocols/openai-chat-completions';

afterEach(() => vi.restoreAllMocks());

const signed = { type: 'thinking', thinking: 'original', signature: 'sig', future: { kept: true } };
const redacted = { type: 'redacted_thinking', data: 'opaque' };

test('Messages replays full LiteLLM reasoning records and filters unsigned or empty thinking', () => {
  const message = flowayReasoningFields('edited scalar', encodeChatCompletionsReasoningData('litellm-thinking-blocks', [signed, { type: 'thinking', thinking: 'unsigned' }, { ...signed, thinking: '  ' }, redacted]));
  const blocks = thinkingBlocksFromChatCompletions(message)!;
  expect(blocks).toEqual([signed, redacted]);
  if (blocks[0].type !== 'thinking') throw new Error('Expected signed thinking');
  blocks[0].thinking = 'modified';
  expect(thinkingBlocksFromChatCompletions(message)).toEqual([signed, redacted]);
});

test.each(['openrouter-reasoning-details', 'litellm-reasoning-items'] as const)('Messages warns and ignores recognized %s history', standard => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  expect(thinkingBlocksFromChatCompletions(flowayReasoningFields('ignored', encodeChatCompletionsReasoningData(standard, [null])))).toBeUndefined();
  expect(warn).toHaveBeenCalledExactlyOnceWith('Floway ignored Chat Completions reasoning data for Messages:', { expected: 'litellm-thinking-blocks', received: standard });
});

test.each([{ blocks: [null] }, { blocks: [{ type: 'redacted_thinking' }] }, { blocks: [{ type: 'thinking', thinking: 1 }] }])('Messages rejects malformed matching sidecar $blocks', ({ blocks }) => {
  expect(() => thinkingBlocksFromChatCompletions(flowayReasoningFields('', encodeChatCompletionsReasoningData('litellm-thinking-blocks', blocks)))).toThrow('Malformed');
});
