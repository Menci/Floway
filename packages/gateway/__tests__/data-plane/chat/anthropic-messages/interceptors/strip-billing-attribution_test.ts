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
