import { test } from 'vitest';

import { stripBillingAttribution } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/strip-billing-attribution.ts';
import type { AnthropicMessagesInvocation } from '../../../../../src/data-plane/chat/anthropic-messages/interceptors/types.ts';
import { mockChatGatewayCtx } from '../../../../test-utils/gateway-ctx.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEventEx } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { assertEquals, stubModelCandidate, testTelemetryModelIdentity } from '@floway-dev/test-utils';
import { type ExecuteResult, eventResult } from '@floway-dev/upstream';

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
