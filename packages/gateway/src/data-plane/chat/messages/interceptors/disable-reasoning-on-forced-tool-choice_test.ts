import { test } from 'vitest';

import { withReasoningDisabledOnForcedToolChoice } from './disable-reasoning-on-forced-tool-choice.ts';
import type { MessagesInvocation } from './types.ts';
import { createNonResponsesSourceStore } from '../../responses/items/store.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { type ExecuteResult, eventResult } from '@floway-dev/provider';
import { stubModelCandidate, testTelemetryModelIdentity, assertEquals } from '@floway-dev/test-utils';

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

const invocation = (
  payload: MessagesPayload,
  enabledFlags: ReadonlySet<string> = new Set(['disable-reasoning-on-forced-tool-choice']),
): MessagesInvocation => ({
  payload,
  candidate: stubModelCandidate({
    model: { endpoints: { messages: {} } },
    enabledFlags,
  }),
  targetApi: 'messages',
  headers: new Headers(),
});

test('messages forced tool_choice disables thinking and strips output_config', async () => {
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high' },
    tool_choice: { type: 'tool', name: 'x' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

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

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

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

    await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

    assertEquals(input.payload.thinking, {
      type: 'enabled',
      budget_tokens: 1024,
    });
  }
});

test('messages forced tool_choice preserves structured-output format while stripping reasoning effort', async () => {
  const schema = { type: 'object', properties: { x: { type: 'string' } }, required: ['x'], additionalProperties: false };
  const input = invocation({
    model: 'm',
    messages: [],
    max_tokens: 1,
    thinking: { type: 'enabled', budget_tokens: 1024 },
    output_config: { effort: 'high', format: { type: 'json_schema', schema } },
    tool_choice: { type: 'tool', name: 'x' },
  });

  await withReasoningDisabledOnForcedToolChoice(input, stubCtx, okEvents);

  assertEquals(input.payload.thinking, { type: 'disabled' });
  assertEquals(input.payload.output_config, { format: { type: 'json_schema', schema } });
});
