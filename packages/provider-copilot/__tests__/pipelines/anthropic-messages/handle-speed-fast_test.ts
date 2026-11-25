import { expect, test } from 'vitest';

import { handleSpeedFast } from '../../../src/pipelines/anthropic-messages/handle-speed-fast.ts';
import { runStage } from '../stage.ts';
import { createAnthropicMessagesUsage, type AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';

const body = {
  model: 'claude-opus-4.6',
  messages: [{ role: 'user' as const, content: 'hi' }],
  max_tokens: 128,
};

test('Copilot strips standard speed and preserves an unknown speed for upstream validation', async () => {
  const standard = await runStage(handleSpeedFast, 'anthropicMessages', { payload: { ...body, speed: 'standard' } });
  const unknown = await runStage(handleSpeedFast, 'anthropicMessages', { payload: { ...body, speed: 'unknown-speed' } });
  expect(standard.payload).not.toHaveProperty('speed');
  expect(unknown.payload.speed).toBe('unknown-speed');
});

test('Copilot strips Fast Mode and reports it in the initial usage event', async () => {
  const event: AnthropicMessagesStreamEventEx = {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', model: 'claude-opus-4.6-fast', role: 'assistant',
      stop_reason: null, stop_sequence: null, stop_details: null, container: null, content: [],
      usage: createAnthropicMessagesUsage(10, 0),
    },
  };
  const { payload, stream, done } = await runStage(handleSpeedFast, 'anthropicMessages', {
    payload: { ...body, speed: 'fast' },
  }, {
    stream: (async function* () {
      yield { ok: true, value: event } as const;
    })(),
  });
  if (!stream) throw new Error('Expected Anthropic Messages stream');
  const items = await Array.fromAsync(stream);
  await done;
  expect(payload).not.toHaveProperty('speed');
  expect(items).toMatchObject([{ ok: true, value: { message: { usage: { speed: 'fast' } } } }]);
});
