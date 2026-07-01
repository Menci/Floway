import { test } from 'vitest';

import { stripBillingAttribution } from './strip-billing-attribution.ts';
import type { MessagesInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubCtx: ChatGatewayCtx = {
  apiKeyId: 'test-key',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore('test-key'),
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

interface InvocationOptions {
  flagOn?: boolean;
}

const invocation = (payload: MessagesPayload, { flagOn = true }: InvocationOptions = {}): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({
    model: { endpoints: { messages: {} } },
    enabledFlags: flagOn ? new Set(['strip-billing-attribution']) : new Set(),
  }),
  targetApi: 'messages',
  headers: new Headers(),
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
      { type: 'text', text: 'You are a helpful assistant.' },
      { type: 'text', text: 'x-anthropic-billing-header: token\ncch=abcdef12345' },
      { type: 'text', text: 'Keep going. cch=99fffaa1;' },
    ],
  });

  await stripBillingAttribution(input, stubCtx, okEvents);

  assertEquals(input.payload.system, [
    { type: 'text', text: 'You are a helpful assistant.' },
    { type: 'text', text: 'Keep going.' },
  ]);
});

test('deletes the system field entirely when every array block becomes empty', async () => {
  const input = invocation({
    model: 'm',
    max_tokens: 1,
    messages: [],
    system: [
      { type: 'text', text: 'x-anthropic-billing-header: token' },
      { type: 'text', text: 'cch=deadbeef1234;' },
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
