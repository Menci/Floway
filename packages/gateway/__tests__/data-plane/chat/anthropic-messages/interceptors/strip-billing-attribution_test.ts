import { test } from 'vitest';

import { stripBillingAttribution } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/strip-billing-attribution.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx = mockChatGatewayCtx();

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEventEx>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEventEx>> {})(), testTelemetryModelIdentity));

interface InvocationOptions {
  flagOn?: boolean;
  anthropicBeta?: readonly string[];
}

const invocation = (payload: AnthropicMessagesPayload, { flagOn = true, anthropicBeta = [] }: InvocationOptions = {}): AnthropicMessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({
    model: { endpoints: { anthropicMessages: {} } },
    enabledFlags: flagOn ? new Set(['strip-billing-attribution']) : new Set(),
  }),
  targetApi: 'anthropicMessages',
  headers: new Headers(),
  anthropicBeta,
});

test('strips billing-header lines and cch hashes from a string system prompt while preserving the rest', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: 'You are a helpful assistant.\nx-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;\nKeep going.',
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, 'You are a helpful assistant.\n\n\nKeep going.');
});

test('strips per-block from an array-form system prompt and filters blocks that become empty', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { citations: null, type: 'text', text: 'You are a helpful assistant.' },
      { citations: null, type: 'text', text: 'x-anthropic-billing-header: token\ncch=abcdef12345' },
      { citations: null, type: 'text', text: 'Keep going. cch=99fffaa1;' },
    ],
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, [
    { citations: null, type: 'text', text: 'You are a helpful assistant.' },
    { citations: null, type: 'text', text: 'Keep going.' },
  ]);
});

test('deletes the system field entirely when every array block becomes empty', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { citations: null, type: 'text', text: 'x-anthropic-billing-header: token' },
      { citations: null, type: 'text', text: 'cch=deadbeef1234;' },
    ],
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals('system' in input.payload, false);
});

test('deletes a string system field that becomes empty after stripping', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: 'x-anthropic-billing-header: token\ncch=deadbeef1234;',
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals('system' in input.payload, false);
});

test('is a no-op when system is absent', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals('system' in input.payload, false);
});

test('leaves a system prompt without billing markers untouched', async () => {
  const original = 'You are a helpful assistant. Respond in markdown and use code fences for snippets.';
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: original,
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, original);
});

test('leaves the billing block intact when the strip flag is off (claude-code default)', async () => {
  const system = 'You are a helpful assistant.\nx-anthropic-billing-header: per-turn-token\ncch=deadbeef1234;\nKeep going.';
  const input = invocation(
    {
      model: 'm',
      max_tokens: 1,
      messages: [],
      system,
    },
    { flagOn: false },
  );

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, system);
});

test('leaves an array-form billing block intact when the strip flag is off', async () => {
  const system = [
    { type: 'text' as const, text: 'You are a helpful assistant.' },
    { type: 'text' as const, text: 'x-anthropic-billing-header: token\ncch=abcdef12345' },
    { type: 'text' as const, text: 'Keep going. cch=99fffaa1;' },
  ];
  const input = invocation(
    {
      model: 'm',
      max_tokens: 1,
      messages: [],
      system,
    },
    { flagOn: false },
  );

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, system);
});

test('drops the Claude Code beta flag and keeps every other beta flag', async () => {
  const input = invocation(
    { model: 'm', max_tokens: 1, messages: [] },
    { anthropicBeta: ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'context-1m-2025-08-07'] },
  );

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.anthropicBeta, ['interleaved-thinking-2025-05-14', 'context-1m-2025-08-07']);
});

test('keeps the Claude Code beta flag when the strip flag is off (claude-code default)', async () => {
  const anthropicBeta = ['claude-code-20250219', 'oauth-2025-04-20'];
  const input = invocation({ model: 'm', max_tokens: 1, messages: [] }, { flagOn: false, anthropicBeta });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.anthropicBeta, anthropicBeta);
});
