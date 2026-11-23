import { test } from 'vitest';

import { resolveAnthropicMessagesDownstreamThinkingDisplay } from '../../../src/stages/anthropic-messages/promote-thinking-display.ts';
import { fakeCopilotWire, invokeAnthropic, protocolSse } from '../../pipeline-fixture.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals } from '@floway-dev/test-utils';

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

const runThinking = async (
  payload: AnthropicMessagesPayload,
  frames: AsyncIterable<ProtocolFrame<AnthropicMessagesStreamEventEx>> | readonly ProtocolFrame<AnthropicMessagesStreamEventEx>[] = [doneFrame()],
) => {
  const { model: id, ...requestPayload } = payload;
  let wire: AnthropicMessagesPayload | undefined;
  const { provider, model, fetcher } = await fakeCopilotWire('/v1/messages', id, async request => {
    wire = await request.json() as AnthropicMessagesPayload;
    return protocolSse(frames);
  });
  const result = await invokeAnthropic(provider.pipelines.anthropicMessages, model, requestPayload, [], fetcher);
  if (wire === undefined) throw new Error('Expected the Copilot request');
  return { wire, events: result.events };
};

test('Copilot thinking display overrides omitted but preserves full', async () => {
  const omitted = await runThinking(makePayload({ type: 'adaptive', display: 'omitted' }));
  const full = await runThinking(makePayload({ type: 'adaptive', display: 'full' }));

  assertEquals(omitted.wire.thinking, { type: 'adaptive', display: 'summarized' });
  assertEquals(full.wire.thinking, { type: 'adaptive', display: 'full' });
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

  const result = await runThinking(makePayload({ type: 'adaptive', display: 'omitted' }), frames);
  assertEquals(result.events, [
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
