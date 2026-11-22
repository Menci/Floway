import { test } from 'vitest';

import { omitPromotedThinkingTextFromProtocolFrames, promoteCopilotThinkingDisplay, resolveAnthropicMessagesDownstreamThinkingDisplay } from '../../../src/stages/anthropic-messages/promote-thinking-display.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

const collect = async <T>(events: AsyncIterable<T>): Promise<T[]> => {
  const collected: T[] = [];
  for await (const event of events) collected.push(event);
  return collected;
};

const makePayload = (
  thinking: AnthropicMessagesPayload['thinking'],
  overrides: {
    model?: string;
  } = {},
): AnthropicMessagesPayload => ({
  model: overrides.model ?? 'claude-opus-4.7-1m-internal',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 128,
  ...(thinking ? { thinking } : {}),
});

test('resolveAnthropicMessagesDownstreamThinkingDisplay exposes 4.7+ omitted by default and older Claude as summarized', () => {
  assertEquals(resolveAnthropicMessagesDownstreamThinkingDisplay(makePayload({ type: 'adaptive' })), 'omitted');
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay(makePayload({ type: 'adaptive' }, { model: 'claude-opus-4-7-20260219' })),
    'omitted',
  );
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay(makePayload({ type: 'adaptive' }, { model: 'claude-opus-4.6' })),
    'summarized',
  );
  assertEquals(
    resolveAnthropicMessagesDownstreamThinkingDisplay(makePayload({ type: 'adaptive' }, { model: 'gpt-5.2' })),
    'summarized',
  );
});

test('promoteCopilotThinkingDisplay overrides omitted but preserves full', () => {
  const omitted = promoteCopilotThinkingDisplay(makePayload({ type: 'adaptive', display: 'omitted' }));
  const full = promoteCopilotThinkingDisplay(makePayload({ type: 'adaptive', display: 'full' }));

  assertEquals(omitted.payload.thinking !== undefined && 'display' in omitted.payload.thinking ? omitted.payload.thinking.display : undefined, 'summarized');
  assertEquals(full.payload.thinking !== undefined && 'display' in full.payload.thinking ? full.payload.thinking.display : undefined, 'full');
});

test('promoteCopilotThinkingDisplay simulates omitted display on protocol events', async () => {
  const frames = (async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {
    yield eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_start',
      index: 0,
      content_block: { signature: '', type: 'thinking', thinking: 'summary prefix' },
    });
    yield eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'summary body' },
    });
    yield eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_unchanged' },
    });
    yield eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_stop',
      index: 0,
    });
    yield doneFrame();
  })();

  assertEquals(await collect(omitPromotedThinkingTextFromProtocolFrames(frames)), [
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_start',
      index: 0,
      content_block: { signature: '', type: 'thinking', thinking: '' },
    }),
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'signature_delta', signature: 'sig_unchanged' },
    }),
    eventFrame<AnthropicMessagesStreamEventEx>({
      type: 'content_block_stop',
      index: 0,
    }),
    doneFrame(),
  ]);
});
