import { test } from 'vitest';

import { copilotAnthropicMessagesStripCacheControlExtensions } from '../../../src/stages/anthropic-messages/strip-cache-control-extensions.ts';
import type { AnthropicMessagesPayload, AnthropicMessagesStreamEvent } from '@floway-dev/protocols/anthropic-messages';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { applyProviderStage, type AnthropicMessagesProbe, type ExecuteResult, eventResult } from '@floway-dev/test-utils';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<AnthropicMessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<AnthropicMessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: AnthropicMessagesPayload): AnthropicMessagesProbe => ({
  payload,
  headers: new Headers(),
  anthropicBeta: [],
  model: stubProviderModel({ endpoints: { anthropicMessages: {} } }),
});

test('strips scope and ttl from system, tools, and message content blocks while keeping the marker', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: [
      { type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'system' } as { type: 'ephemeral' } },
    ],
    tools: [
      { name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral', ttl: '1h' } as { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'q', cache_control: { type: 'ephemeral', scope: 'session' } as { type: 'ephemeral' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'u1', name: 't', input: {}, cache_control: { type: 'ephemeral', ttl: '5m' } as { type: 'ephemeral' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'u1', content: 'ok', cache_control: { type: 'ephemeral', ttl: '1h', scope: 'session' } as { type: 'ephemeral' } },
        ],
      },
    ],
  });

  await applyProviderStage(copilotAnthropicMessagesStripCacheControlExtensions, ctx, okEvents);

  assertEquals(ctx.payload.system, [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.tools, [{ name: 't', input_schema: { type: 'object' }, cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.messages[0].content, [{ type: 'text', text: 'q', cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.messages[1].content, [{ type: 'tool_use', id: 'u1', name: 't', input: {}, cache_control: { type: 'ephemeral' } }]);
  assertEquals(ctx.payload.messages[2].content, [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok', cache_control: { type: 'ephemeral' } }]);
});

test('deletes cache_control entirely if no recognised field survives the strip', async () => {
  // Hypothetical caller that only ships unsupported sub-fields with no `type`.
  // Without `type` there is no canonical marker to keep — drop the field so we
  // do not forward an empty object that upstream would still reject.
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: [
      { type: 'text', text: 'sys', cache_control: { ttl: '1h', scope: 'system' } as unknown as { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: 'hi' }],
  });

  await applyProviderStage(copilotAnthropicMessagesStripCacheControlExtensions, ctx, okEvents);

  assertEquals(ctx.payload.system, [{ type: 'text', text: 'sys' }]);
});

test('no-op when no cache_control is present anywhere', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    system: 'plain system',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 't', input_schema: { type: 'object' } }],
  });

  await applyProviderStage(copilotAnthropicMessagesStripCacheControlExtensions, ctx, okEvents);

  assertEquals(ctx.payload.system, 'plain system');
  assertEquals(ctx.payload.tools, [{ name: 't', input_schema: { type: 'object' } }]);
  assertEquals(ctx.payload.messages[0].content, 'hi');
});
