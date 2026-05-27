import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel({ upstreamEndpoints: ['messages'] }),
  enabledFlags: new Set(['disable-reasoning-on-forced-tool-choice']),
  headers: {},
});

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

test('messages forced tool_choice disables thinking and strips output_config', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'x' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.thinking, { type: 'disabled' });
  assertEquals(input.payload.output_config, undefined);
});

test('messages any tool_choice also disables thinking', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    tool_choice: { type: 'any' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

  assertEquals(input.payload.thinking, { type: 'disabled' });
});

test('messages non-forced tool_choice leaves reasoning untouched', async () => {
  for (const type of ['auto', 'none'] as const) {
    const input = invocation({
      model: 'm',
      messages: [],
      max_tokens: 1,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      tool_choice: { type },
    });

    await withReasoningDisabledOnForcedToolChoice(input, stubRequest, okEvents);

    assertEquals(input.payload.thinking, {
      type: 'enabled',
      budget_tokens: 1024,
    });
  }
});
