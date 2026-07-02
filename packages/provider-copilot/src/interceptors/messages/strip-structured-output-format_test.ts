import { test } from 'vitest';

import { withStructuredOutputFormatStripped } from './strip-structured-output-format.ts';
import type { MessagesBoundaryCtx } from './types.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import { eventResult } from '@floway-dev/provider';
import { assertEquals, stubProviderModel, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stubRequest = {};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesBoundaryCtx => ({
  payload,
  headers: new Headers(),
  model: stubProviderModel({ endpoints: { messages: {} } }),
});

const jsonSchemaFormat = {
  type: 'json_schema',
  schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
};

test('strips output_config.format and drops an emptied container', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { format: jsonSchemaFormat } as MessagesPayload['output_config'],
  });

  await withStructuredOutputFormatStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.output_config, undefined);
});

test('preserves sibling output_config.effort', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'medium', format: jsonSchemaFormat } as MessagesPayload['output_config'],
  });

  await withStructuredOutputFormatStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.output_config, { effort: 'medium' });
});

test('no-op when output_config is absent', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await withStructuredOutputFormatStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.output_config, undefined);
});

test('no-op when output_config carries only sibling fields', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 10,
    messages: [{ role: 'user', content: 'hi' }],
    output_config: { effort: 'low' },
  });

  await withStructuredOutputFormatStripped(ctx, stubRequest, okEvents);

  assertEquals(ctx.payload.output_config, { effort: 'low' });
});
