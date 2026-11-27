import { expect, test } from 'vitest';

import { promoteThinkingDisplay, resolveAnthropicMessagesDownstreamThinkingDisplay } from '../../../src/pipelines/anthropic-messages/promote-thinking-display.ts';
import { inspectStages, type StageFixture } from '../inspect.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { stubUpstreamModel } from '@floway-dev/test-utils';

const fixture = (
  thinking: AnthropicMessagesPayload['thinking'],
  publicId = 'claude-opus-4-7',
): StageFixture<'anthropicMessages'> => ({
  payload: {
    model: 'claude-opus-4.7-1m-internal',
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 128,
    ...(thinking === undefined ? {} : { thinking }),
  },
  model: stubUpstreamModel({ id: publicId, endpoints: { anthropicMessages: {} } }),
});

test.each([
  ['claude-opus-4.7-1m-internal', 'omitted'],
  ['claude-opus-4-7-20260219', 'omitted'],
  ['claude-opus-4.6', 'summarized'],
  ['gpt-5.2', 'summarized'],
])('resolves the default thinking display for %s', (model, expected) => {
  expect(resolveAnthropicMessagesDownstreamThinkingDisplay(fixture({ type: 'adaptive' }).payload, model)).toBe(expected);
});

test.each([
  ['omitted', 'summarized'],
  ['full', 'full'],
] as const)('sends %s thinking as %s', async (display, expected) => {
  const inspected = await inspectStages('anthropicMessages', promoteThinkingDisplay, fixture({ type: 'adaptive', display }));
  expect(inspected.payload.thinking).toEqual({ type: 'adaptive', display: expected });
});

test('suppresses thinking text while preserving the original signature and content boundaries', async () => {
  const events: AnthropicMessagesStreamEventEx[] = [
    { type: 'content_block_start', index: 0, content_block: { signature: '', type: 'thinking', thinking: 'summary prefix' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'summary body' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig_unchanged' } },
    { type: 'content_block_stop', index: 0 },
  ];
  const inspected = await inspectStages('anthropicMessages', promoteThinkingDisplay, fixture({ type: 'adaptive' }),
    ({ stream }) => ({ kind: 'stream', stream: stream(events) }));
  expect(inspected.payload.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
  expect(inspected.items).toEqual([
    { ok: true, value: { ...events[0], content_block: { signature: '', type: 'thinking', thinking: '' } } },
    { ok: true, value: events[2] },
    { ok: true, value: events[3] },
  ]);
});
