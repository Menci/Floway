import { test } from 'vitest';

import { withStructuredOutputFormatStripped } from './strip-structured-output-format.ts';
import { assertEquals } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel, testTelemetryModelIdentity } from '../../../../../test-helpers.ts';
import type { MessagesInvocation, RequestContext } from '../../../../llm/interceptors.ts';
import { eventResult, type ExecuteResult } from '../../../../llm/shared/errors/result.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEventData } from '@floway-dev/protocols/messages';

const stubRequest: RequestContext = {
  requestStartedAt: 0,
  runtimeLocation: 'test',
  clientStream: false,
};

const okEvents = (): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEventData>>> =>
  Promise.resolve(eventResult((async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {})(), testTelemetryModelIdentity));

const invocation = (payload: MessagesPayload): MessagesInvocation => ({
  sourceApi: 'messages',
  targetApi: 'messages',
  model: payload.model,
  upstream: 'test-upstream',
  payload,
  provider: stubProvider(),
  upstreamModel: stubUpstreamModel(),
  enabledFlags: new Set<string>(),
  headers: {},
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
