import { expect, test } from 'vitest';

import { promoteThinkingDisplay, resolveAnthropicMessagesDownstreamThinkingDisplay } from '../../../src/pipelines/anthropic-messages/promote-thinking-display.ts';
import { runStage } from '../stage.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const body = {
  model: 'claude-opus-4.7-1m-internal',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 128,
};

test.each([
  ['claude-opus-4.7-1m-internal', 'omitted'],
  ['claude-opus-4-7-20260219', 'omitted'],
  ['claude-opus-4.6', 'summarized'],
  ['gpt-5.2', 'summarized'],
])('defaults to %s thinking display', (model, expected) => {
  expect(resolveAnthropicMessagesDownstreamThinkingDisplay({ thinking: { type: 'adaptive' } }, model)).toBe(expected);
});

test('promotes omitted thinking display to summarized and preserves full display', async () => {
  const payload = (display: 'omitted' | 'full'): AnthropicMessagesPayload => ({
    ...body,
    thinking: { type: 'adaptive', display },
  });
  const omitted = await runStage(promoteThinkingDisplay, 'anthropicMessages', { payload: payload('omitted') });
  const full = await runStage(promoteThinkingDisplay, 'anthropicMessages', { payload: payload('full') });
  expect(omitted.payload.thinking).toMatchObject({ display: 'summarized' });
  expect(full.payload.thinking).toMatchObject({ display: 'full' });
});

test('omitted thinking display removes thinking text and retains the original signature', async () => {
  const events: AnthropicMessagesStreamEventEx[] = [
    { type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: 'summary prefix' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary body' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_unchanged' } },
    { type: 'content_block_stop', index: 0 },
  ];
  const payload: AnthropicMessagesPayload = { ...body, thinking: { type: 'adaptive' } };
  const result = await runStage(promoteThinkingDisplay, 'anthropicMessages', { payload }, {
    stream: (async function* () {
      for (const event of events) yield { ok: true, value: event } as const;
    })(),
  });
  if (!result.stream) throw new Error('Expected Anthropic Messages stream');
  const items = await Array.fromAsync(result.stream);
  await result.done;
  expect(items).toEqual([
    { ok: true, value: { type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: '' } } },
    { ok: true, value: events[2] },
    { ok: true, value: events[3] },
  ]);
});
