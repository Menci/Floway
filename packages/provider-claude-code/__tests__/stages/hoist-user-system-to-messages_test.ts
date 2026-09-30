import { test } from 'vitest';

import { hoistUserSystemToMessages } from '../../src/stages/hoist-user-system-to-messages.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import type { AnthropicMessagesProbe } from '@floway-dev/test-utils';
import { applyProviderStage, assertEquals, stubProviderModel } from '@floway-dev/test-utils';

type ClaudeCodeStageProbe = AnthropicMessagesProbe & { upstreamId: string };

const okEvents = (): Promise<ProviderStreamResult<AnthropicMessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: AnthropicMessagesPayload): ClaudeCodeStageProbe => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
  upstreamId: 'up_test',
});

test('captures a string system into a synthetic user/assistant pair and drops `system`', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'real question' }],
    system: 'You are a pirate.',
  });

  await applyProviderStage(hoistUserSystemToMessages, ctx, okEvents, { 'request.claudeCode.shaped': false });

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages, [
    { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nYou are a pirate.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Understood. I will follow these instructions.' }] },
    { role: 'user', content: 'real question' },
  ]);
});

test('joins multi-block system into one synthetic turn with blank-line separators', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [
      { type: 'text', text: 'first rule' },
      { type: 'text', text: 'second rule' },
    ],
  });

  await applyProviderStage(hoistUserSystemToMessages, ctx, okEvents, { 'request.claudeCode.shaped': false });

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages[0], { role: 'user', content: [{ type: 'text', text: '[System Instructions]\nfirst rule\n\nsecond rule' }] });
});

test('drops system entirely when caller did not send one and leaves messages untouched', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await applyProviderStage(hoistUserSystemToMessages, ctx, okEvents, { 'request.claudeCode.shaped': false });

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages.length, 1);
  assertEquals(ctx.payload.messages[0], { role: 'user', content: 'hi' });
});

test('drops system but does not inject a synthetic turn when system text is empty', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: '' }],
  });

  await applyProviderStage(hoistUserSystemToMessages, ctx, okEvents, { 'request.claudeCode.shaped': false });

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages.length, 1);
});
